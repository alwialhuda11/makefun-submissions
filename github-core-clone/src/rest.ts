// rest.ts: GitHub REST v3 conformance surface.
import {
  parseCommit, parseTag, sha1, ZERO_OID, hashObject, parseTree,
} from './core.ts';
import {
  createRepo, getRepo, getObject, resolveRef, setRef, listRefs,
  commitTreeFromFiles, treeSnapshot, buildTreeFromFiles, commitTree,
  addIssue, getIssue, addComment, addPull, getPull, commitForPull,
  type State, type Repo, type Issue, type Pull,
} from './store.ts';

export const VIEWER = 'adaiversen';
export const STRANGER = 'olgabauer';

export class RestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authed: boolean;
}

type Json = Record<string, unknown>;

export function repoObject(repo: Repo): Json {
  return {
    id: 1000 + (repo.name.length % 1000),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    html_url: `https://example.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    clone_url: `https://example.com/${repo.owner}/${repo.name}.git`,
    size: 0,
    open_issues_count: repo.issues.length,
    has_issues: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
  };
}

function commitObj(repo: Repo, oid: string): Json {
  const obj = repo.objects.get(oid);
  const c = obj ? parseCommit(obj.data) : { tree: '', parents: [], message: '', author: '', committer: '', timestamp: 0 };
  return {
    sha: oid,
    commit: {
      message: c.message,
      author: { name: 'make.fun', email: 'agent@make.fun', date: new Date(c.timestamp * 1000).toISOString() },
      committer: { name: 'make.fun', email: 'agent@make.fun', date: new Date(c.timestamp * 1000).toISOString() },
      tree: { sha: c.tree },
    },
    parents: c.parents.map((p) => ({ sha: p })),
  };
}

function commitHistory(repo: Repo, tip: string): Array<{ oid: string; info: ReturnType<typeof parseCommit> }> {
  const out: Array<{ oid: string; info: ReturnType<typeof parseCommit> }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.shift()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    seen.add(oid);
    out.push({ oid, info });
    stack.push(...info.parents);
  }
  return out;
}

function contentEntry(repo: Repo, path: string, oid: string): Json {
  const obj = repo.objects.get(oid);
  const data = obj ? obj.data : Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop(),
    path,
    content: data.toString('base64'),
    sha: oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

function walkTree(repo: Repo, oid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (treeOid: string, pre: string) => {
    const obj = repo.objects.get(treeOid);
    if (!obj) return;
    const entries = parseTree(obj.data);
    for (const e of entries) {
      if (e.mode === '40000') walk(e.oid, pre + e.name + '/');
      else out.set(pre + e.name, e.oid);
    }
  };
  walk(oid, prefix);
  return out;
}

function treeForTree(repo: Repo, oid: string): Map<string, string> {
  return walkTree(repo, oid);
}

function currentTree(repo: Repo): Map<string, string> | null {
  const tip = resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
  if (!tip) return null;
  const obj = repo.objects.get(tip);
  if (!obj) return null;
  const c = parseCommit(obj.data);
  return treeForTree(repo, c.tree);
}

function issueObj(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((l) => ({ name: l, color: 'ededed', id: issue.id * 100 + repo.labels.indexOf(l) })),
    created_at: issue.created_at,
    updated_at: issue.created_at,
    closed_at: null,
    comments: (repo.comments.get(issue.number) || []).length,
    user: { login: repo.owner },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObj(repo: Repo, pull: Pull): Json {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    user: { login: repo.owner },
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

interface RouteMatch { params: Record<string, string> }

function parseRoute(path: string): { parts: string[] } {
  const p = path.replace(/^\/api\/v3/, '').replace(/^\/+|\/+$/g, '');
  return { parts: p ? p.split('/') : [] };
}

export function handleRest(s: State, req: Req): { status: number; body: Json | Json[] | null } {
  const { parts } = parseRoute(req.path);
  const method = req.method;

  // GET / and /meta
  if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
    return { status: 200, body: { current_user_url: '/api/v3/user' } };
  }
  if (parts.length === 1 && parts[0] === 'meta') {
    return { status: 200, body: { installed_version: '2.0.0' } };
  }
  if (parts.length === 1 && parts[0] === 'user') {
    if (method === 'GET') return { status: 200, body: { login: VIEWER, id: 1000, type: 'User' } };
  }
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const repos = [...s.repos.values()].filter((r) => r.owner === VIEWER).map(repoObject);
      return { status: 200, body: repos };
    }
    if (method === 'POST') {
      const body = req.body as Json;
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name) throw new RestError(422, 'Validation Failed');
      let repo = getRepo(s, VIEWER, name);
      if (repo) throw new RestError(422, 'Repository creation failed');
      repo = createRepo(s, VIEWER, name, {
        private: body?.private === true,
        description: typeof body?.description === 'string' ? body.description : '',
      });
      return { status: 201, body: repoObject(repo) };
    }
  }
  // user/repos pagination handled by caller (Link header)
  if (parts.length === 3 && parts[0] === 'repos') {
    const owner = parts[1], name = parts[2];
    const repo = getRepo(s, owner, name);
    if (!repo) throw new RestError(404, 'Not Found');
    if (method === 'GET') return { status: 200, body: repoObject(repo) };
    if (method === 'PATCH') {
      const body = req.body as Json;
      if (typeof body?.description === 'string') repo.description = body.description;
      return { status: 200, body: repoObject(repo) };
    }
    if (method === 'DELETE') {
      s.repos.delete(`${owner}/${name}`);
      return { status: 204, body: null };
    }
  }
  // /repos/{o}/{r}/branches
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'branches') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    const branches = listRefs(repo).filter((r) => r.name.startsWith('refs/heads/')).map((r) => ({
      name: r.name.replace('refs/heads/', ''),
      commit: { sha: r.oid },
    }));
    return { status: 200, body: branches };
  }
  // /repos/{o}/{r}/branches/{branch}
  if (parts.length === 5 && parts[0] === 'repos' && parts[3] === 'branches') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    const oid = resolveRef(repo, `refs/heads/${parts[4]}`);
    if (!oid) throw new RestError(404, 'Not Found');
    return { status: 200, body: { name: parts[4], commit: { sha: oid } } };
  }
  // /repos/{o}/{r}/commits
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'commits') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    const sha = req.query.get('sha');
    const tip = sha ? resolveRef(repo, sha) : resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
    if (!tip) return { status: 200, body: [] };
    const hist = commitHistory(repo, tip);
    return { status: 200, body: hist.map((h) => commitObj(repo, h.oid)) };
  }
  // /repos/{o}/{r}/contents/{path}
  if (parts.length >= 5 && parts[0] === 'repos' && parts[3] === 'contents') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    const filePath = parts.slice(4).join('/');
    const ref = req.query.get('ref');
    if (method === 'PUT' || method === 'POST') {
      const body = req.body as Json;
      const message = typeof body?.message === 'string' ? body.message : 'update';
      const contentB64 = typeof body?.content === 'string' ? body.content : '';
      const content = Buffer.from(contentB64, 'base64');
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      const sha = typeof body?.sha === 'string' ? body.sha : undefined;
      const branchRef = `refs/heads/${branch}`;
      const tip = resolveRef(repo, branchRef);
      if (tip !== undefined) {
        // update path: check stale sha
        const tree = treeForTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        const existing = tree.get(filePath);
        if (sha !== undefined) {
          if (!existing) throw new RestError(409, 'Conflict');
          if (existing.toLowerCase() !== sha.toLowerCase()) throw new RestError(409, 'Conflict');
        }
        const files = treeSnapshot(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        files.set(filePath, content);
        const newTip = commitTreeFromFiles(repo, files, [tip], message, 'make.fun <agent@make.fun>', Date.now() / 1000 | 0);
        setRef(repo, branchRef, newTip);
        const contentOid = hashObject('blob', content);
        return { status: 200, body: { content: { name: filePath.split('/').pop(), path: filePath, sha: contentOid, encoding: 'base64', content: contentB64, size: content.length }, commit: { sha: newTip } } };
      }
      // create on unborn repo (no branch yet)
      const files = new Map<string, Buffer>();
      files.set(filePath, content);
      const newTip = commitTreeFromFiles(repo, files, [], message, 'make.fun <agent@make.fun>', Date.now() / 1000 | 0);
      setRef(repo, branchRef, newTip);
      const contentOid = hashObject('blob', content);
      return { status: 201, body: { content: { name: filePath.split('/').pop(), path: filePath, sha: contentOid, encoding: 'base64', content: contentB64, size: content.length }, commit: { sha: newTip } } };
    }
    if (method === 'DELETE') {
      const body = req.body as Json;
      const branchRef = `refs/heads/${repo.defaultBranch}`;
      const tip = resolveRef(repo, branchRef);
      if (!tip) throw new RestError(404, 'Not Found');
      const files = treeSnapshot(repo, parseCommit(repo.objects.get(tip)!.data).tree);
      if (!files.has(filePath)) throw new RestError(404, 'Not Found');
      files.delete(filePath);
      const newTip = commitTreeFromFiles(repo, files, [tip], typeof body?.message === 'string' ? body.message : 'delete', 'make.fun <agent@make.fun>', Date.now() / 1000 | 0);
      setRef(repo, branchRef, newTip);
      return { status: 200, body: { commit: { sha: newTip } } };
    }
    if (method === 'GET') {
      const pathOid = ref
        ? (() => { const r = resolveRef(repo, ref); return r ? treeForTree(repo, parseCommit(repo.objects.get(r)!.data).tree).get(filePath) : undefined; })()
        : currentTree(repo)?.get(filePath);
      if (pathOid !== undefined) return { status: 200, body: contentEntry(repo, filePath, pathOid) };
      // directory listing
      const tree = ref ? (() => { const r = resolveRef(repo, ref); return r ? treeForTree(repo, parseCommit(repo.objects.get(r)!.data).tree) : null; })() : currentTree(repo);
      if (!tree) throw new RestError(404, 'Not Found');
      const prefix = filePath + '/';
      const entries: Json[] = [];
      const seenDirs = new Set<string>();
      for (const [path, oid] of tree) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash === -1) {
            entries.push(contentEntry(repo, path, oid));
          } else {
            const dir = rest.slice(0, slash);
            if (!seenDirs.has(dir)) {
              seenDirs.add(dir);
              entries.push({ type: 'dir', name: dir, path: prefix + dir, sha: sha1(dir), size: 0 });
            }
          }
        }
      }
      entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { status: 200, body: entries };
    }
  }
  // /repos/{o}/{r}/git/refs
  if (parts.length === 5 && parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'refs') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    if (method === 'POST') {
      const body = req.body as Json;
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const oid = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/heads/') || !oid) throw new RestError(422, 'Validation Failed');
      if (resolveRef(repo, ref) !== undefined) throw new RestError(422, 'Reference already exists');
      setRef(repo, ref, oid);
      return { status: 201, body: { ref, object: { sha: oid, type: 'commit' } } };
    }
  }
  // /repos/{o}/{r}/git/refs/heads/{branch}
  if (parts.length === 7 && parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'refs' && parts[5] === 'heads') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    const oid = resolveRef(repo, `refs/heads/${parts[6]}`);
    if (!oid) throw new RestError(404, 'Not Found');
    return { status: 200, body: { ref: `refs/heads/${parts[6]}`, object: { sha: oid, type: 'commit' } } };
  }
  // /repos/{o}/{r}/labels
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'labels') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    if (method === 'POST') {
      const body = req.body as Json;
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name) throw new RestError(422, 'Validation Failed');
      if (!repo.labels.includes(name)) repo.labels.push(name);
      return { status: 201, body: { name, color: typeof body?.color === 'string' ? body.color : 'ededed' } };
    }
  }
  // issues
  if (parts.length >= 4 && parts[0] === 'repos' && parts[3] === 'issues') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    const rest = parts.slice(4);
    if (rest.length === 0) {
      if (method === 'POST') {
        const body = req.body as Json;
        const title = typeof body?.title === 'string' ? body.title : '';
        if (!title) throw new RestError(422, 'Validation Failed');
        const labels = Array.isArray(body?.labels) ? (body.labels as Json[]).map((l) => (typeof l === 'string' ? l : String(l?.name ?? ''))) : [];
        for (const l of labels) if (!repo.labels.includes(l)) throw new RestError(422, 'Validation Failed');
        const issue = addIssue(repo, title, typeof body?.body === 'string' ? body.body : '', labels);
        return { status: 201, body: issueObj(repo, issue) };
      }
      if (method === 'GET') {
        const state = req.query.get('state') || 'open';
        let issues = repo.issues.filter((i) => state === 'all' || i.state === state);
        const sort = req.query.get('sort');
        const direction = req.query.get('direction') || 'desc';
        if (sort === 'created') {
          issues = [...issues].sort((a, b) => {
            const c = a.number - b.number;
            return direction === 'asc' ? c : -c;
          });
        } else {
          issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        return { status: 200, body: issues.map((i) => issueObj(repo, i)) };
      }
    }
    if (rest.length === 1) {
      const num = Number(rest[0]);
      const issue = getIssue(repo, num);
      if (!issue) throw new RestError(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: issueObj(repo, issue) };
      if (method === 'PATCH') {
        const body = req.body as Json;
        if (body?.state === 'closed') issue.state = 'closed';
        return { status: 200, body: issueObj(repo, issue) };
      }
    }
    if (rest.length === 2 && rest[1] === 'comments') {
      const num = Number(rest[0]);
      const issue = getIssue(repo, num);
      if (!issue) throw new RestError(404, 'Not Found');
      if (method === 'POST') {
        const body = req.body as Json;
        const c = addComment(repo, num, typeof body?.body === 'string' ? body.body : '');
        return { status: 201, body: { id: c.id, body: c.body, created_at: c.created_at } };
      }
      if (method === 'GET') {
        const comments = repo.comments.get(num) || [];
        return { status: 200, body: comments.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at })) };
      }
    }
  }
  // pulls
  if (parts.length >= 4 && parts[0] === 'repos' && parts[3] === 'pulls') {
    const repo = getRepo(s, parts[1], parts[2]);
    if (!repo) throw new RestError(404, 'Not Found');
    const rest = parts.slice(4);
    if (rest.length === 0) {
      if (method === 'POST') {
        const body = req.body as Json;
        const head = typeof body?.head === 'string' ? body.head : '';
        const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
        const title = typeof body?.title === 'string' ? body.title : '';
        if (!head || !title) throw new RestError(422, 'Validation Failed');
        const headSha = resolveRef(repo, `refs/heads/${head}`);
        const baseSha = resolveRef(repo, `refs/heads/${base}`);
        if (!headSha || !baseSha) throw new RestError(422, 'Validation Failed');
        const pull = addPull(repo, { title, body: typeof body?.body === 'string' ? body.body : '', head, base, headSha, baseSha });
        return { status: 201, body: pullObj(repo, pull) };
      }
      if (method === 'GET') {
        const state = req.query.get('state') || 'open';
        let pulls = repo.pulls.filter((p) => state === 'all' || p.state === state);
        pulls = [...pulls].sort((a, b) => b.number - a.number);
        return { status: 200, body: pulls.map((p) => pullObj(repo, p)) };
      }
    }
    if (rest.length === 1) {
      const num = Number(rest[0]);
      const pull = getPull(repo, num);
      if (!pull) throw new RestError(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: pullObj(repo, pull) };
      if (method === 'PUT') {
        // merge
        if (pull.state === 'closed') return { status: 200, body: pullObj(repo, pull) };
        const mergeCommit = commitForPull(repo, pull);
        if (!mergeCommit) throw new RestError(405, 'Merge conflict');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = new Date().toISOString();
        pull.mergeCommitSha = mergeCommit;
        setRef(repo, `refs/heads/${pull.base}`, mergeCommit);
        return { status: 200, body: { sha: mergeCommit, merged: true, message: `Pull request #${pull.number}` } };
      }
    }
    if (rest.length === 2 && rest[1] === 'files') {
      const num = Number(rest[0]);
      const pull = getPull(repo, num);
      if (!pull) throw new RestError(404, 'Not Found');
      const baseTip = resolveRef(repo, `refs/heads/${pull.base}`);
      const headTip = resolveRef(repo, `refs/heads/${pull.head}`);
      if (!baseTip || !headTip) return { status: 200, body: [] };
      const baseTree = treeForTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
      const headTree = treeForTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
      const files: Json[] = [];
      const all = new Set([...baseTree.keys(), ...headTree.keys()]);
      for (const path of all) {
        const b = baseTree.get(path), h = headTree.get(path);
        if (b === h) continue;
        const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
        files.push({ filename: path, status, additions: status === 'removed' ? 0 : 1, deletions: status === 'added' ? 0 : 1, changes: 1 });
      }
      return { status: 200, body: files };
    }
  }
  throw new RestError(404, 'Not Found');
}

export function isOwnedByViewer(repo: Repo): boolean {
  return repo.owner === VIEWER;
}
