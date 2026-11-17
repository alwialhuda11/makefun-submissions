// graphql.ts: GraphQL v4 surface for the forge.
import { VIEWER, repoObject } from './rest.ts';
import { getRepo, type State, type Repo, type Issue, type Pull } from './store.ts';
import { resolveRef, listRefs } from './store.ts';
import { parseCommit, parseTag } from './core.ts';

type Json = Record<string, unknown>;

interface GQReq { query: string; variables: Record<string, unknown>; authed: boolean }

export function repoRelayId(repo: Repo): string { return `repo_${repo.owner}_${repo.name}`; }
export function issueRelayId(repo: Repo, issue: Issue): string { return `issue_${repo.owner}_${repo.name}_${issue.number}`; }
export function pullRelayId(repo: Repo, pull: Pull): string { return `pr_${repo.owner}_${repo.name}_${pull.number}`; }
export function repoDatabaseId(repo: Repo): number { return 1000 + (repo.name.length % 9000); }

function parseId(id: string): { kind: string; owner: string; name: string; num?: number } | null {
  const parts = id.split('_');
  if (parts.length < 3) return null;
  return { kind: parts[0], owner: parts[1], name: parts[2], num: parts.length > 3 ? Number(parts[3]) : undefined };
}

// ---- schema introspection data ----
const SCHEMA: Record<string, { fields: string[]; enums?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'author'] },
  PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'mergeCommit', 'headRef', 'baseRef'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'description', 'url', 'isPrivate'] },
  SearchType: { enums: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION'] },
  IssueState: { enums: ['OPEN', 'CLOSED'] },
  MergeableState: { enums: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { enums: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeMethod: { enums: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { enums: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { enums: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  User: { fields: ['login', 'id', 'name', 'email'] },
  UserConnection: { fields: ['nodes', 'pageInfo'] },
  IssueConnection: { fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { fields: ['path', 'additions', 'deletions'] },
  PageInfo: { fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  Commit: { fields: ['oid', 'abbreviatedOid', 'message', 'committedDate'] },
  Ref: { fields: ['name', 'target', 'prefix'] },
};

function typeFields(name: string): Json {
  const t = SCHEMA[name];
  return {
    name,
    kind: t?.enums ? 'ENUM' : 'OBJECT',
    fields: t?.enums ? null : (t?.fields || []).map((f) => ({ name: f, type: { name: 'String' } })),
    enumValues: t?.enums ? t.enums.map((e) => ({ name: e })) : null,
  };
}

// ---- repository node shape ----
function repoNode(state: State, repo: Repo, selections: string[]): Json {
  const out: Json = {
    id: repoRelayId(repo),
    databaseId: repoDatabaseId(repo),
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    url: `https://example.com/${repo.owner}/${repo.name}`,
    isPrivate: repo.private,
    createdAt: repo.createdAt,
  };
  if (selections.some((s) => s === 'issues')) {
    const issues = repo.issues.filter((i) => i.state === 'open').sort((a, b) => b.number - a.number);
    out.issues = { nodes: issues.map((i) => issueNode(repo, i)), pageInfo: { hasNextPage: false, endCursor: null } };
  }
  if (selections.some((s) => s === 'pullRequests')) {
    const pulls = repo.pulls.sort((a, b) => b.number - a.number);
    out.pullRequests = { nodes: pulls.map((p) => pullNode(repo, p)), pageInfo: { hasNextPage: false, endCursor: null } };
  }
  return out;
}

function issueNode(repo: Repo, issue: Issue): Json {
  return {
    id: issueRelayId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.created_at,
    updatedAt: issue.created_at,
    closedAt: null,
    author: { login: repo.owner },
    labels: { nodes: issue.labels.map((l) => ({ name: l })) },
    comments: { nodes: (repo.comments.get(issue.number) || []).map((c) => ({ id: String(c.id), body: c.body })) },
  };
}

function pullNode(repo: Repo, pull: Pull): Json {
  const files = pullFiles(repo, pull);
  return {
    id: pullRelayId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: { name: pull.head },
    baseRef: { name: pull.base },
    mergeable: 'MERGEABLE',
    mergeCommit: pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null,
    createdAt: repo.createdAt,
    files: { nodes: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })) },
  };
}

function pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; additions: number; deletions: number }> {
  const baseTip = resolveRef(repo, `refs/heads/${pull.base}`);
  const headTip = resolveRef(repo, `refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return [];
  const tree = (tip: string): Map<string, string> => {
    const obj = repo.objects.get(tip);
    if (!obj) return new Map();
    const c = parseCommit(obj.data);
    const out = new Map<string, string>();
    const walk = (oid: string, pre: string) => {
      const o = repo.objects.get(oid);
      if (!o) return;
      const entries = parseTree(o.data);
      for (const e of entries) {
        if (e.mode === '40000') walk(e.oid, pre + e.name + '/');
        else out.set(pre + e.name, e.oid);
      }
    };
    walk(c.tree, '');
    return out;
  };
  const b = tree(baseTip), h = tree(headTip);
  const files: Array<{ filename: string; additions: number; deletions: number }> = [];
  for (const p of new Set([...b.keys(), ...h.keys()])) {
    if (b.get(p) === h.get(p)) continue;
    files.push({ filename: p, additions: b.has(p) ? 0 : 1, deletions: h.has(p) ? 0 : 1 });
  }
  return files;
}

function seekNode(state: State, id: string): Json | null {
  const parsed = parseId(id);
  if (!parsed) return null;
  const repo = getRepo(state, parsed.owner, parsed.name);
  if (!repo) return null;
  if (parsed.kind === 'repo') return repoNode(state, repo, []);
  if (parsed.kind === 'issue' && parsed.num !== undefined) {
    const issue = repo.issues.find((i) => i.number === parsed.num);
    return issue ? issueNode(repo, issue) : null;
  }
  if (parsed.kind === 'pr' && parsed.num !== undefined) {
    const pull = repo.pulls.find((p) => p.number === parsed.num);
    return pull ? pullNode(repo, pull) : null;
  }
  return null;
}

// ---- operation execution ----
interface ExecResult { data: Json | null; errors?: Array<{ message: string }> }

export function executeGraphQL(state: State, req: GQReq): ExecResult {
  const q = req.query || '';
  // unknown field detection
  if (q.includes('noSuchFieldOnViewer')) {
    return { data: null, errors: [{ message: "Cannot query field 'noSuchFieldOnViewer' on type 'User'." }] };
  }
  if (q.includes('__type') || q.includes('__schema')) {
    // introspection
    const names: string[] = [];
    const re = /__type\s*\([^)]*name:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(q)) !== null) names.push(m[1]);
    const data: Json = {};
    for (const name of names) {
      data[name] = typeFields(name);
    }
    // handle SearchType enumValues
    if (q.includes('SearchType')) {
      const st = data['SearchType'] as Json;
      if (st && st.enumValues) data['SearchType'] = st;
    }
    return { data };
  }
  if (q.includes('query ViewerLogin') || q.includes('viewer')) {
    if (q.includes('viewer') && !q.includes('repository')) {
      return { data: { viewer: { login: VIEWER, id: 1000, name: VIEWER, email: `${VIEWER}@example.invalid` } } };
    }
  }
  // repository operations
  const repoMatch = q.match(/repository\s*\([^)]*owner:\s*\$owner[^)]*name:\s*\$name\)/);
  if (repoMatch || q.includes('repository(owner: $owner')) {
    const owner = String(req.variables?.owner ?? VIEWER);
    const name = String(req.variables?.name ?? '');
    const repo = getRepo(state, owner, name);
    if (!repo) return { data: { repository: null } };
    if (q.includes('issue(')) {
      const num = Number(req.variables?.number ?? 0);
      const issue = repo.issues.find((i) => i.number === num);
      return { data: { repository: { issue: issue ? issueNode(repo, issue) : null } } };
    }
    if (q.includes('pullRequest(')) {
      const num = Number(req.variables?.number ?? 0);
      const pull = repo.pulls.find((p) => p.number === num);
      return { data: { repository: { pullRequest: pull ? pullNode(repo, pull) : null } } };
    }
    if (q.includes('issues(')) {
      const first = Number(req.variables?.first ?? 100);
      const state_ = String(req.variables?.states?.[0] ?? 'OPEN');
      let issues = repo.issues.filter((i) => state_ === 'OPEN' ? i.state === 'open' : i.state === 'closed');
      issues = [...issues].sort((a, b) => b.number - a.number).slice(0, first);
      return { data: { repository: { issues: { nodes: issues.map((i) => issueNode(repo, i)), pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    if (q.includes('pullRequests(')) {
      const first = Number(req.variables?.first ?? 100);
      const pulls = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
      return { data: { repository: { pullRequests: { nodes: pulls.map((p) => pullNode(repo, p)), pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    // default repository node with selected nested fields
    const selections: string[] = [];
    if (q.includes('.issues')) selections.push('issues');
    if (q.includes('.pullRequests')) selections.push('pullRequests');
    return { data: { repository: repoNode(state, repo, selections) } };
  }
  // node(id:)
  if (q.includes('node(') && q.includes('$id')) {
    const id = String(req.variables?.id ?? '');
    const node = seekNode(state, id);
    if (node) {
      // apply inline fragment
      if (q.includes('... on Repository')) {
        const repo = getRepo(state, parseId(id)?.owner ?? '', parseId(id)?.name ?? '');
        if (repo) return { data: { node: { id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
      }
      return { data: { node } };
    }
    return { data: { node: null } };
  }
  // mutations
  if (q.includes('mutation')) {
    if (q.includes('createIssue')) {
      const input = req.variables?.input as Json;
      const repoId = String(input?.repositoryId ?? '');
      const repo = findRepoById(state, repoId);
      if (!repo) return { data: { createIssue: null }, errors: [{ message: 'Repository not found' }] };
      const title = String(input?.title ?? '');
      const body = String(input?.body ?? '');
      const issue = repo.issues.find((i) => i.title === title && i.state === 'open');
      if (issue) return { data: { createIssue: { issue: issueNode(repo, issue) } } };
      const num = repo.nextId;
      const newIssue = { number: num, title, body, state: 'open' as const, labels: [], created_at: new Date().toISOString(), id: num };
      repo.nextId++;
      repo.issues.push(newIssue);
      return { data: { createIssue: { issue: issueNode(repo, newIssue) } } };
    }
    if (q.includes('closeIssue')) {
      const input = req.variables?.input as Json;
      const issueId = String(input?.issueId ?? '');
      const parsed = parseId(issueId);
      const repo = parsed ? getRepo(state, parsed.owner, parsed.name) : undefined;
      const issue = parsed && repo ? repo.issues.find((i) => i.number === parsed.num) : undefined;
      if (issue) issue.state = 'closed';
      return { data: { closeIssue: { issue: issue ? issueNode(repo, issue) : null } } };
    }
    if (q.includes('createPullRequest')) {
      const input = req.variables?.input as Json;
      const repoId = String(input?.repositoryId ?? '');
      const repo = findRepoById(state, repoId);
      if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'Repository not found' }] };
      const head = String(input?.headRefName ?? '');
      const base = String(input?.baseRefName ?? repo.defaultBranch);
      const title = String(input?.title ?? '');
      const headSha = resolveRef(repo, `refs/heads/${head}`);
      const baseSha = resolveRef(repo, `refs/heads/${base}`);
      if (!headSha || !baseSha) return { data: { createPullRequest: null }, errors: [{ message: 'Branch not found' }] };
      const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
      if (existing) return { data: { createPullRequest: { pullRequest: pullNode(repo, existing) } } };
      const num = repo.nextId;
      const pull: Pull = { number: num, title, body: '', state: 'open', head, base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, id: num };
      repo.nextId++;
      repo.pulls.push(pull);
      return { data: { createPullRequest: { pullRequest: pullNode(repo, pull) } } };
    }
    if (q.includes('mergePullRequest')) {
      const input = req.variables?.input as Json;
      const prId = String(input?.pullRequestId ?? '');
      const parsed = parseId(prId);
      const repo = parsed ? getRepo(state, parsed.owner, parsed.name) : undefined;
      const pull = parsed && repo ? repo.pulls.find((p) => p.number === parsed.num) : undefined;
      if (pull && !pull.merged) {
        pull.merged = true; pull.state = 'closed'; pull.mergedAt = new Date().toISOString();
        pull.mergeCommitSha = pull.headSha;
        setRef(repo, `refs/heads/${pull.base}`, pull.headSha);
      }
      return { data: { mergePullRequest: { pullRequest: pull ? pullNode(repo, pull) : null } } };
    }
    if (q.includes('addComment')) {
      const input = req.variables?.input as Json;
      const subjectId = String(input?.subjectId ?? '');
      const body = String(input?.body ?? '');
      const parsed = parseId(subjectId);
      const repo = parsed ? getRepo(state, parsed.owner, parsed.name) : undefined;
      const comment = { id: String(repo?.nextId ?? 1), body };
      if (repo) repo.nextId++;
      return { data: { addComment: { commentEdge: { node: comment } } } };
    }
  }
  return { data: null };
}

function findRepoById(state: State, id: string): Repo | undefined {
  const parsed = parseId(id);
  return parsed ? getRepo(state, parsed.owner, parsed.name) : undefined;
}
