// git.ts: smart HTTP git server (upload-pack v2/v0, receive-pack v0).
import {
  ZERO_OID, encodePktLine, encodePktLines, parsePktLines, pktFlush, pktDelim, pktResponseEnd,
  parseCommit, parseTree, parseTag, writePack, readPack, collectReachable, sha1,
  type GitObject, type Packet,
} from './core.ts';
import { getRepo, treeSnapshot, resolveRef, listRefs, setRef, type State, type Repo } from './store.ts';

const AGENT = 'makefun-forge/1.0';

function pktData(s: string | Buffer): Buffer { return encodePktLine(s); }

// ---------------- v0 ref advertisement ----------------
function v0Advertise(service: string, repo: Repo): Buffer {
  const pre = `# service=${service}\n`;
  const lines: Array<string | Buffer | 'flush'> = [pre, 'flush'];
  const refs = listRefs(repo);
  const caps = service === 'git-receive-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT
    : 'side-band-64k ofs-delta agent=' + AGENT + ' symref=HEAD:refs/heads/' + repo.defaultBranch;
  let first = true;
  for (const ref of refs) {
    let line = `${ref.oid} ${ref.name}`;
    if (first) { line += '\0' + caps; first = false; }
    lines.push(line + '\n');
  }
  if (first) {
    // empty repo: capabilities^{} pseudo-ref
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  }
  // add HEAD symref as a ref line -> the advertisement lists refs, HEAD is separate
  lines.push('flush');
  return encodePktLines(lines as Array<string | Uint8Array | 'flush' | 'delim' | 'response-end'>);
}

// ---------------- v2 advertise ----------------
function v2Advertise(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs\n',
    'fetch\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------- v2 ls-refs ----------------
function v2LsRefs(repo: Repo, packets: Packet[]): Buffer {
  let peel = false, symrefs = false;
  const prefixes: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const out: Array<string | 'flush'> = [];
  let headAdded = false;
  for (const ref of listRefs(repo)) {
    let include = prefixes.length === 0;
    if (!include) {
      for (const pf of prefixes) if (ref.name.startsWith(pf)) { include = true; break; }
    }
    if (!include) continue;
    let line = `${ref.oid} ${ref.name}\n`;
    if (ref.name === 'refs/heads/' + repo.defaultBranch && !headAdded) {
      if (symrefs) line = `${ref.oid} HEAD symref-target:${ref.name}\n`;
      headAdded = true;
    }
    out.push(line);
    if (peel && ref.name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const t = parseTag(obj.data);
        out.push(`${t.object} ${ref.name}^{}\n`);
      }
    }
  }
  out.push('flush');
  return encodePktLines(out as Array<string | Uint8Array | 'flush' | 'delim' | 'response-end'>);
}

// ---------------- v2 fetch ----------------
function v2Fetch(repo: Repo, packets: Packet[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5));
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line === 'done') done = true;
  }
  const havesSet = new Set(haves);
  const toSend: GitObject[] = [];
  const tipSet = wants.filter((w) => w !== ZERO_OID);
  if (tipSet.length) {
    const reachable = collectReachable(tipSet, (oid) => repo.objects.get(oid));
    for (const oid of reachable) {
      if (havesSet.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj) toSend.push(obj);
    }
  }
  const pack = writePack(toSend);
  const lines: Array<string | Buffer | 'flush' | 'delim' | 'response-end'> = [
    'acknowledgments\n',
    'NAK\n',
    'delim',
    'packfile\n',
  ];
  // send pack in pkt-line chunks
  for (let i = 0; i < pack.length; i += 65516) {
    lines.push(pack.subarray(i, i + 65516));
  }
  lines.push('flush', 'response-end');
  return encodePktLines(lines as Array<string | Uint8Array | 'flush' | 'delim' | 'response-end'>);
}

// ---------------- v0 upload-pack fetch ----------------
function v0Fetch(repo: Repo, packets: Packet[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5));
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line === 'done') done = true;
    else if (line.startsWith('deepen ')) { /* shallow: we answer as if full */ }
  }
  void done;
  const tips = wants.filter((w) => w !== ZERO_OID);
  const toSend: GitObject[] = [];
  if (tips.length) {
    const reachable = collectReachable(tips, (oid) => repo.objects.get(oid));
    const haveSet = new Set(haves);
    for (const oid of reachable) {
      if (haveSet.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj) toSend.push(obj);
    }
  }
  const pack = writePack(toSend);
  // side-band-64k: each pkt-line is a band byte (1=pack) + data
  const out: Array<Buffer | 'flush'> = [pktData('NAK\n')];
  // send pack in side-band chunks
  for (let i = 0; i < pack.length; i += 65515) {
    const chunk = pack.subarray(i, i + 65515);
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push('flush');
  return Buffer.concat(out.map((x) => (x === 'flush' ? pktFlush() : x)));
}

// ---------------- receive-pack push ----------------
function receivePack(repo: Repo, packets: Packet[], bodyRest: Buffer): Buffer {
  // commands are pkt-lines after the flush; the rest is the packfile (possibly preceded by NO flush)
  const commands: Array<{ old: string; new: string; ref: string }> = [];
  let packBuf: Buffer | null = null;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('object-format')) continue;
    if (line.startsWith('agent')) continue;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/.exec(line);
    if (m) commands.push({ old: m[1], new: m[2], ref: m[3] });
  }
  // pack data is everything after the last flush of the command section, minus trailing?.
  packBuf = bodyRest.length ? bodyRest : null;

  const reports: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  const newObjects = new Map<string, GitObject>();
  if (packBuf && packBuf.length >= 12) {
    try {
      const objs = readPack(packBuf, repo.objects);
      for (const [oid, obj] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      void newObjects;
    } catch (e) {
      unpackOk = false;
      unpackDetail = String(e instanceof Error ? e.message : e);
    }
  }

  for (const cmd of commands) {
    if (cmd.ref.endsWith('HEAD')) { reports.push(`ng ${cmd.ref} cannot update HEAD`); continue; }
    const oldTip = resolveRef(repo, cmd.ref);
    if (cmd.new === ZERO_OID) {
      // delete
      if (oldTip !== undefined) { repo.refs.delete(cmd.ref); reports.push(`ok ${cmd.ref}`); }
      else reports.push(`ng ${cmd.ref} could not delete, ref not found`);
      continue;
    }
    // fast-forward check: old ref must be an ancestor of new
    if (oldTip !== undefined && oldTip !== ZERO_OID) {
      const reachable = collectReachable([cmd.new], (oid) => repo.objects.get(oid));
      if (!reachable.has(oldTip)) {
        reports.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.new);
    if (cmd.ref === 'refs/heads/' + repo.defaultBranch) repo.refs.set('HEAD', cmd.new);
    reports.push(`ok ${cmd.ref}`);
  }

  // report-status
  const lines: Array<string | 'flush'> = ['unpack ' + (unpackOk ? 'ok' : 'ng ' + unpackDetail)];
  for (const r of reports) lines.push(r);
  lines.push('flush');
  return encodePktLines(lines as Array<string | Uint8Array | 'flush' | 'delim' | 'response-end'>);
}

// ---------------- entrypoint ----------------
export interface GitHttpResult { status: number; contentType: string; body: Buffer }

export function handleGitInfoRefs(s: State, owner: string, name: string, service: string, gitProtocol: string | null): GitHttpResult {
  const repo = getRepo(s, owner, name);
  if (!repo) return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n') };
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertise() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertise('git-upload-pack', repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertise('git-receive-pack', repo) };
  }
  return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n') };
}

export function handleGitService(s: State, owner: string, name: string, service: string, body: Buffer, gitProtocol: string | null): GitHttpResult {
  const repo = getRepo(s, owner, name);
  if (!repo) return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n') };
  const { packets, rest } = parsePktLines(body);
  if (service === 'git-upload-pack') {
    // first data packet is command=... for v2
    if (gitProtocol === 'version=2') {
      const first = packets.find((p) => p.kind === 'data');
      const cmd = first ? first.payload.toString('utf8').replace(/command=/g, '').split('\n')[0] : '';
      if (cmd === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2LsRefs(repo, packets) };
      }
      if (cmd === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2Fetch(repo, packets) };
      }
      return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad request"}\n') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0Fetch(repo, packets) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(repo, packets, Buffer.from(rest)) };
  }
  return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n') };
}
