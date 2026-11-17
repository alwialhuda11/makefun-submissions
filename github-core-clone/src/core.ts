// core.ts: SHA-1 object model, pkt-line, and packfile read/write for the git forge.
// Node 22 stdlib only. Mirrors the suite's git-client.ts expectations exactly.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer }

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------- pkt-line ----------
export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (data.length > 65516) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
}
export function pktFlush(): Buffer { return Buffer.from('0000', 'ascii'); }
export function pktDelim(): Buffer { return Buffer.from('0001', 'ascii'); }
export function pktResponseEnd(): Buffer { return Buffer.from('0002', 'ascii'); }
export function encodePktLines(items: Array<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

// parse a sequence of pkt-lines into packets; handles a trailing raw buffer (packfile) too.
export function parsePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (Number.isNaN(len) || len === 0) {
      if (buf[i] === 0x30) { i += 4; packets.push({ kind: 'flush' }); continue; }
      break;
    }
    if (len < 4 || i + len > buf.length) break;
    const body = buf.subarray(i + 4, i + len);
    if (len === 5) {
      if (body[0] === 0x31) { i += len; packets.push({ kind: 'delim' }); continue; }
      if (body[0] === 0x32) { i += len; packets.push({ kind: 'response-end' }); continue; }
    }
    packets.push({ kind: 'data', payload: Buffer.from(body) });
    i += len;
  }
  return { packets, rest: Buffer.from(buf.subarray(i)) };
}

// ---------- object parse/build ----------
export interface CommitInfo { tree: string; parents: string[]; author: string; committer: string; message: string; timestamp: number }
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '', author = '', committer = '', timestamp = 0;
  const parents: string[] = [];
  let msgIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) { committer = line.slice(10); const m = /(\d+) [+-]\d{4}$/.exec(committer); if (m) timestamp = Number(m[1]); }
    else if (line === '' ) { msgIdx = i + 1; break; }
  }
  return { tree, parents, author: author.trim(), committer: committer.trim(), message: lines.slice(msgIdx).join('\n'), timestamp };
}
export function buildCommit(c: { tree: string; parents: string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author} ${c.timestamp} +0000\n`;
  s += `committer ${c.committer} ${c.timestamp} +0000\n`;
  s += `\n${c.message}`;
  if (!s.endsWith('\n')) s += '\n';
  return Buffer.from(s, 'utf8');
}
export interface TreeEntry { mode: string; name: string; oid: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.toString('ascii', i, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export interface TagInfo { object: string; type: string; tag: string; message: string; timestamp: number }
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let object = '', type = '', tag = '', timestamp = 0;
  let msgIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) { const m = /(\d+) [+-]\d{4}$/.exec(line); if (m) timestamp = Number(m[1]); }
    else if (line === '') { msgIdx = i + 1; break; }
  }
  return { object, type, tag, message: lines.slice(msgIdx).join('\n'), timestamp };
}
export function buildTag(t: { object: string; type: string; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  let s = `object ${t.object}\ntype ${t.type}\ntag ${t.tag}\ntagger ${t.tagger} ${t.timestamp} +0000\n\n`;
  s += t.message;
  if (!s.endsWith('\n')) s += '\n';
  return Buffer.from(s, 'utf8');
}
export function parseAuthorNameEmail(line: string): { name: string; email: string } {
  const m = /^(.*) <([^>]*)>/.exec(line.trim());
  return m ? { name: m[1], email: m[2] } : { name: line.trim(), email: '' };
}

// ---------- packfile ----------
export function readPack(buf: Buffer, base: Map<string, GitObject>): Map<string, GitObject> {
  if (buf.length < 12) throw new Error('pack too short');
  const sig = buf.toString('ascii', 0, 4);
  if (sig !== 'PACK') throw new Error('bad pack signature');
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  const objs = new Map<string, GitObject>();
  let i = 12;
  const inflate = (start: number): { data: Buffer; next: number } => {
    const z = inflateSync(buf.subarray(start));
    return { data: z, next: buf.length - inflateSync(buf.subarray(start)).length };
  };
  for (let n = 0; n < count; n++) {
    let b = buf[i++];
    let type = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) { b = buf[i++]; size |= (b & 0x7f) << shift; shift += 7; }
    if (type === 6) { // ODFS_DELTA
      let ofs = buf[i++]; const first = ofs; let comm = 7;
      while (ofs & 0x80) { ofs = buf[i++]; ofs = (ofs & 0x7f) | (prev << comm); comm += 7; }
      void first;
      const baseOid = findBaseByOffset(objs, buf, 0); void baseOid;
      // We don't have offset indexes; store raw and resolve later
      throw new Error('OFS_DELTA not supported in server read');
    } else if (type === 7) { // REF_DELTA
      const baseOid = buf.subarray(i, i + 20).toString('hex'); i += 20;
      const raw = inflate(i); i = raw.next;
      const baseObj = base.get(baseOid) || objs.get(baseOid);
      if (!baseObj) throw new Error('missing delta base ' + baseOid);
      const data = applyDelta(raw.data, baseObj.data);
      objs.set(hashObject(baseObj.type, data), { type: baseObj.type, data });
    } else {
      const typeName = ['', 'commit', 'tree', 'blob', 'tag'][type] as GitObjectType;
      const raw = inflate(i); i = raw.next;
      objs.set(hashObject(typeName, raw.data), { type: typeName, data: raw.data });
    }
  }
  void version;
  return objs;
}

function applyDelta(delta: Buffer, base: Buffer): Buffer {
  let i = 0;
  const readSize = (): number => {
    let size = 0, shift = 0, b;
    do { b = delta[i++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return size;
  };
  const srcSize = readSize();
  const dstSize = readSize();
  void srcSize;
  const out = Buffer.allocUnsafe(dstSize);
  let outPos = 0;
  while (i < delta.length) {
    const cmd = delta[i++];
    if (cmd & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (cmd & 0x01) cpOff |= delta[i++];
      if (cmd & 0x02) cpOff |= delta[i++] << 8;
      if (cmd & 0x04) cpOff |= delta[i++] << 16;
      if (cmd & 0x08) cpOff |= delta[i++] << 24;
      if (cmd & 0x10) cpSize |= delta[i++];
      if (cmd & 0x20) cpSize |= delta[i++] << 8;
      if (cmd & 0x40) cpSize |= delta[i++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (cmd) {
      for (let k = 0; k < cmd; k++) out[outPos++] = delta[i++];
    }
  }
  return out;
}

function findBaseByOffset(map: Map<string, GitObject>, buf: Buffer, index: number): string {
  void map; void buf; void index;
  return '';
}

// write a pack with plain (non-delta) objects
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2])];
  const countBuf = Buffer.allocUnsafe(4);
  countBuf.writeUInt32BE(list.length, 0);
  parts.push(countBuf);
  for (const obj of list) {
    const typeMap: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
    let header = Buffer.from([(typeMap[obj.type] << 4) | (obj.data.length & 0x0f)]);
    let size = obj.data.length >> 4;
    let hdr = header;
    while (size > 0) {
      const b = 0x80 | (size & 0x7f);
      hdr = Buffer.concat([hdr, Buffer.from([b])]);
      size >>= 7;
    }
    parts.push(hdr);
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = sha1(body);
  return Buffer.concat([body, Buffer.from(trailer, 'hex')]);
}

export function collectReachable(tips: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = lookup(oid);
    if (!obj) throw new Error('missing object ' + oid.slice(0, 12));
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      stack.push(t.object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
  return seen;
}
