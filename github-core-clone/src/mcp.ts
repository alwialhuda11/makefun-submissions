// mcp.ts: Model Context Protocol endpoint (JSON-RPC 2.0 over Streamable HTTP).
import { VIEWER, repoObject } from './rest.ts';
import { createRepo, getRepo, addIssue, addPull, commitTreeFromFiles, setRef, resolveRef, type State, type Repo } from './store.ts';

type Json = Record<string, unknown>;

interface McpRequest {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: Json;
}

const REVISION = '2026-07-28';

const TOOLS: Array<{ name: string; description: string; inputSchema: Json }> = [
  { name: 'create_repo', description: 'Create a new repository', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function toolResult(content: unknown, structured?: unknown): Json {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { content: [{ type: 'text', text }], ...(structured !== undefined ? { structuredContent: structured } : {}) };
}

function rpcError(id: number | string | undefined, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function rpcResult(id: number | string | undefined, result: Json): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mapArg(schema: Json, args: Json, canonical: string, semantic: Record<string, unknown>): Json {
  void schema;
  const out: Json = {};
  const props = (schema.properties as Json) || {};
  const keys = Object.keys(props);
  const findKey = (name: string): string | null => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(name);
    for (const k of keys) if (norm(k) === target) return k;
    // synonyms
    const syn: Record<string, string[]> = {
      owner: ['owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace', 'owner_name', 'full_name'],
      repo: ['repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name', 'full_name'],
      title: ['issue_title', 'pr_title', 'pull_request_title', 'subject'],
      body: ['issue_body', 'description', 'content', 'text', 'comment'],
      head: ['head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'from', 'branch'],
      base: ['base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'into'],
      pull_number: ['pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
      name: ['repository', 'repository_name', 'repo_name'],
      state: ['status'],
    };
    for (const [k, list] of Object.entries(syn)) {
      if (target === norm(k)) {
        for (const s of list) { const prop = keys.find((pk) => norm(pk) === norm(s)); if (prop) return prop; }
      }
    }
    return null;
  };
  for (const [key, value] of Object.entries(semantic)) {
    if (value === undefined) continue;
    const prop = findKey(key);
    if (prop) out[prop] = value;
  }
  // full_name fallback
  if (out.repo === undefined && out.repository === undefined) {
    if (typeof semantic.owner === 'string' && typeof semantic.repo === 'string') {
      const fn = keys.find((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'fullname');
      if (fn) out[fn] = `${semantic.owner}/${semantic.repo}`;
    }
  }
  return out;
}

async function callTool(state: State, name: string, args: Json): Promise<{ isError: boolean; result: Json }> {
  const tool = TOOLS.find((t) => t.name === name || t.name.endsWith(name));
  if (!tool) return { isError: true, result: toolResult({ error: { code: -32602, message: `unknown tool ${name}` } }) };
  const fn = name.split('__').pop() || name;
  switch (fn) {
    case 'create_repo': {
      const n = String(args.name ?? args.repository ?? '');
      if (!n) return { isError: true, result: toolResult({ error: 'name required' }) };
      let repo = getRepo(state, VIEWER, n);
      if (!repo) repo = createRepo(state, VIEWER, n, { private: args.private === true, description: String(args.description ?? '') });
      return { isError: false, result: toolResult(repoObject(repo), repoObject(repo)) };
    }
    case 'get_repo': {
      const owner = String(args.owner ?? VIEWER);
      const name = String(args.repo ?? args.repository ?? '');
      const repo = getRepo(state, owner, name);
      if (!repo) return { isError: true, result: toolResult({ error: 'Repository not found' }) };
      return { isError: false, result: toolResult(repoObject(repo), repoObject(repo)) };
    }
    case 'create_issue': {
      const owner = String(args.owner ?? VIEWER);
      const name = String(args.repo ?? args.repository ?? '');
      const repo = getRepo(state, owner, name);
      if (!repo) return { isError: true, result: toolResult({ error: 'Repository not found' }) };
      const issue = addIssue(repo, String(args.title ?? ''), String(args.body ?? ''), []);
      return { isError: false, result: toolResult({ number: issue.number, id: issue.id, title: issue.title, state: issue.state }, { number: issue.number, id: issue.id, title: issue.title, state: issue.state }) };
    }
    case 'list_issues': {
      const owner = String(args.owner ?? VIEWER);
      const name = String(args.repo ?? args.repository ?? '');
      const repo = getRepo(state, owner, name);
      if (!repo) return { isError: true, result: toolResult({ error: 'Repository not found' }) };
      const stateFilter = String(args.state ?? 'open');
      const issues = repo.issues.filter((i) => stateFilter === 'all' || i.state === stateFilter);
      const arr = issues.map((i) => ({ number: i.number, id: i.id, title: i.title, state: i.state }));
      return { isError: false, result: toolResult(arr, arr) };
    }
    case 'create_pull_request': {
      const owner = String(args.owner ?? VIEWER);
      const name = String(args.repo ?? args.repository ?? '');
      const repo = getRepo(state, owner, name);
      if (!repo) return { isError: true, result: toolResult({ error: 'Repository not found' }) };
      const head = String(args.head ?? '');
      const base = String(args.base ?? repo.defaultBranch);
      const headSha = resolveRef(repo, `refs/heads/${head}`);
      const baseSha = resolveRef(repo, `refs/heads/${base}`);
      if (!headSha || !baseSha) return { isError: true, result: toolResult({ error: 'Branch not found' }) };
      const pull = addPull(repo, { title: String(args.title ?? ''), body: '', head, base, headSha, baseSha });
      return { isError: false, result: toolResult({ number: pull.number, id: pull.id, state: 'open', headRefName: head, baseRefName: base }, { number: pull.number, id: pull.id, state: 'open', headRefName: head, baseRefName: base }) };
    }
    case 'merge_pull_request': {
      const owner = String(args.owner ?? VIEWER);
      const name = String(args.repo ?? args.repository ?? '');
      const repo = getRepo(state, owner, name);
      if (!repo) return { isError: true, result: toolResult({ error: 'Repository not found' }) };
      const num = Number(args.pull_number ?? args.number ?? 0);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return { isError: true, result: toolResult({ error: 'Pull request not found' }) };
      pull.merged = true; pull.state = 'closed'; pull.mergedAt = new Date().toISOString(); pull.mergeCommitSha = pull.headSha;
      setRef(repo, `refs/heads/${pull.base}`, pull.headSha);
      return { isError: false, result: toolResult({ number: pull.number, merged: true, state: 'MERGED' }, { number: pull.number, merged: true, state: 'MERGED' }) };
    }
    default:
      return { isError: true, result: toolResult({ error: { code: -32602, message: `unknown tool ${name}` } }) };
  }
}

export interface McpGen { status: number; body: Buffer; contentType: string }

export async function handleMcp(state: State, body: Buffer, authed: boolean): Promise<McpGen> {
  if (!authed) return { status: 401, contentType: 'application/json', body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } })) };
  let req: McpRequest;
  try {
    req = JSON.parse(body.toString('utf8')) as McpRequest;
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })) };
  }
  const id = req.id;
  const method = req.method || '';

  if (method === 'initialize') {
    return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(rpcResult(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
    }))) };
  }
  if (method === 'notifications/initialized') {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }
  if (method === 'server/discover') {
    return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(rpcResult(id, {
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      capabilities: { tools: {} },
      supportedVersions: [REVISION, '2025-11-25'],
    }))) };
  }
  if (method === 'tools/list') {
    return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(rpcResult(id, { tools: TOOLS }))) };
  }
  if (method === 'tools/call') {
    const params = req.params as Json;
    const name = String(params?.name ?? '');
    const args = (params?.arguments as Json) || {};
    const tool = TOOLS.find((t) => t.name === name || t.name.endsWith(name));
    if (!tool) {
      return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(rpcError(id, -32602, `unknown tool: ${name}`))) };
    }
    const mapped = mapArg(tool.inputSchema, args, name, args as Record<string, unknown>);
    const required = (tool.inputSchema.required as string[]) || [];
    const missing = required.filter((r) => !(r in mapped));
    if (missing.length) {
      return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(rpcResult(id, { isError: true, content: [{ type: 'text', text: `missing required argument: ${missing.join(', ')}` }] }))) };
    }
    const outcome = await callTool(state, name, mapped);
    const result: Json = { ...(outcome.isError ? { isError: true } : {}), ...outcome.result };
    return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(rpcResult(id, result))) };
  }
  // unknown method
  return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(rpcError(id, -32601, 'Method not found'))) };
}
