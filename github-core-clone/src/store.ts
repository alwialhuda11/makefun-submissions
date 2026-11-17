// store.ts: in-memory state for the forge. A fresh process per trial so everything lives here.
import { hashObject, type GitObject, type GitObjectType, parseTree, buildTree, parseCommit, buildCommit, type TreeEntry } from './core.ts';

export interface Issue { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; created_at: string; id: number }
export interface Comment { id: number; body: string; created_at: string }
export interface Pull { number: number; title: string; body: string; state: 'open' | 'closed'; head: string; base: string; headSha: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; id: number }
export interface Repo {
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  comments: Map<number, Comment[]>;
  pulls: Pull[];
  labels: string[];
  nextId: number;
  createdAt: string;
}
export interface State { repos: Map<string, Repo>; nextRepoId: number }

export function newState(): State { return { repos: new Map(), nextRepoId: 1 }; }

export function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }

export function getRepo(s: State, owner: string, name: string): Repo | undefined {
  return s.repos.get(repoKey(owner, name));
}

export function createRepo(s: State, owner: string, name: string, opts: { private: boolean; description: string }): Repo {
  const key = repoKey(owner, name);
  const repo: Repo = {
    owner, name, private: opts.private, description: opts.description,
    defaultBranch: 'main',
    objects: new Map(), refs: new Map(),
    issues: [], comments: new Map(), pulls: [], labels: [],
    nextId: 1, createdAt: new Date().toISOString(),
  };
  s.repos.set(key, repo);
  return repo;
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
export function getObject(repo: Repo, oid: string): GitObject | undefined { return repo.objects.get(oid); }
export function treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
  const obj = repo.objects.get(treeOid);
  if (!obj) return [];
  return parseTree(obj.data);
}
export function buildTreeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  interface Node { files: Map<string, Buffer>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make());
      node = node.dirs.get(segs[i])!;
    }
    node.files.set(segs[segs.length - 1], data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries.push({ mode: '100644', name, oid: putObject(repo, 'blob', data) });
    }
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

export function commitTree(repo: Repo, treeOid: string, parents: string[], message: string, author: string, ts: number): string {
  const data = buildCommit({ tree: treeOid, parents, message: message.endsWith('\n') ? message : message + '\n', author, committer: author, timestamp: ts });
  return putObject(repo, 'commit', data);
}

export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === 'HEAD') {
    const head = repo.refs.get('HEAD');
    if (head) return head;
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  const direct = repo.refs.get(`refs/heads/${ref}`);
  if (direct) return direct;
  return repo.refs.get(`refs/tags/${ref}`);
}

export function listRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) if (!name.startsWith('HEAD')) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

export function setRef(repo: Repo, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
  if (ref === `refs/heads/${repo.defaultBranch}`) repo.refs.set('HEAD', oid);
}

export function commitTreeFromFiles(repo: Repo, files: Map<string, Buffer>, parents: string[], message: string, author: string, ts: number): string {
  const tree = buildTreeFromFiles(repo, files);
  return commitTree(repo, tree, parents, message, author, ts);
}

export function treeSnapshot(repo: Repo, treeOid: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (oid: string, prefix: string) => {
    for (const e of treeEntries(repo, oid)) {
      if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
      else {
        const obj = repo.objects.get(e.oid);
        if (obj) out.set(prefix + e.name, obj.data);
      }
    }
  };
  walk(treeOid, '');
  return out;
}

export function addIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = { number: repo.nextId, title, body, state: 'open', labels, created_at: new Date().toISOString(), id: repo.nextId };
  repo.nextId++;
  repo.issues.push(issue);
  return issue;
}
export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((i) => i.number === number);
}
export function addComment(repo: Repo, number: number, body: string): Comment {
  const c: Comment = { id: repo.nextId++, body, created_at: new Date().toISOString() };
  if (!repo.comments.has(number)) repo.comments.set(number, []);
  repo.comments.get(number)!.push(c);
  return c;
}

export function addPull(repo: Repo, p: { title: string; body: string; head: string; base: string; headSha: string; baseSha: string }): Pull {
  const pull: Pull = { number: repo.nextId, title: p.title, body: p.body, state: 'open', head: p.head, base: p.base, headSha: p.headSha, baseSha: p.baseSha, merged: false, mergedAt: null, mergeCommitSha: null, id: repo.nextId };
  repo.nextId++;
  repo.pulls.push(pull);
  return pull;
}
export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((p) => p.number === number);
}
export function commitMeta(ts: number, author: string, message: string) {
  return { author, ts, message };
}
export function commitForPull(repo: Repo, pull: Pull): string | null {
  const baseOid = resolveRef(repo, `refs/heads/${pull.base}`);
  const headOid = resolveRef(repo, `refs/heads/${pull.head}`);
  if (!baseOid || !headOid) return null;
  const baseTree = parseCommit(repo.objects.get(baseOid)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headOid)!.data).tree;
  const baseSnap = treeSnapshot(repo, baseTree);
  const headSnap = treeSnapshot(repo, headTree);
  const merged = new Map(baseSnap);
  for (const [k, v] of headSnap) merged.set(k, v);
  const tree = buildTreeFromFiles(repo, merged);
  const msg = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  return commitTree(repo, tree, [baseOid, headOid], msg, 'make.fun <merge@make.fun>', Date.now() / 1000 | 0);
}
