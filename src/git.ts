// The git core: the object model, packfiles, pkt-line framing, reachability
// walks, and the tree merge logic the forge is built on. Everything here is
// plain Node stdlib (crypto for SHA-1, zlib for pack compression) and works
// purely on in-memory buffers: the store keeps objects in Maps, and this
// module never touches the filesystem or the network.
//
// The wire shapes implemented here are git's own: loose-object hashing
// ("<type> <size>\0" + bytes), tree/commit/tag object layouts, packfile
// version 2 with OFS_DELTA/REF_DELTA, and the pkt-line framing smart HTTP
// uses. Deltas are read (a pushed pack may carry them) but never written:
// packs this forge sends hold whole objects, which the protocol allows.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagInfo {
  readonly object: string;
  readonly type: ObjType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export type Lookup = (oid: string) => GitObject | undefined;

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 over the loose-object framing, exactly as git computes an id. */
export function hashObject(type: ObjType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\0`, 'utf8');
  hash.update(body);
  return hash.digest('hex');
}

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree entry without a mode separator');
    const nul = buf.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > buf.length) throw new Error('tree entry without a name terminator');
    entries.push({
      mode: buf.subarray(off, sp).toString('ascii'),
      name: buf.subarray(sp + 1, nul).toString('utf8'),
      oid: buf.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, directories compared with a trailing slash. */
function treeCompare(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeCompare);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. Unknown headers are dropped; the message is kept whole. */
export function parseCommit(data: Uint8Array): CommitInfo {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = (blank < 0 ? buf : buf.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    // Continuation lines of multi-line headers (gpgsig) start with a space
    // and fall through here harmlessly: they carry no key we model.
  }
  if (!isOid(tree)) throw new Error('commit without a valid tree header');
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. `author`/`committer` are full ident lines. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const p of fields.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagInfo {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = (blank < 0 ? buf : buf.subarray(0, blank)).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) throw new Error('tag header without a value');
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag without a valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error('tag with a bad type header');
  }
  return {
    object,
    type: type as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

/** Follow tag objects to the object they ultimately point at. */
export function peel(lookup: Lookup, oid: string): { oid: string; type: ObjType } {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = lookup(current);
    if (!obj || obj.type !== 'tag' || seen.has(current)) {
      return { oid: current, type: obj?.type ?? 'commit' };
    }
    seen.add(current);
    current = parseTag(obj.data).object;
  }
}

// -------------------------------------------------------------------------------------------
// Deltas and packfiles
// -------------------------------------------------------------------------------------------

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuf = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuf = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= deltaBuf.length) throw new Error('delta size varint truncated');
      const byte = deltaBuf[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuf.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < deltaBuf.length) {
    const op = deltaBuf[off++];
    if ((op & 0x80) !== 0) {
      let copyOff = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit++) {
        if ((op & (1 << bit)) !== 0) {
          if (off >= deltaBuf.length) throw new Error('delta copy truncated');
          copyOff += deltaBuf[off++] * 2 ** (bit * 8);
        }
      }
      for (let bit = 4; bit < 7; bit++) {
        if ((op & (1 << bit)) !== 0) {
          if (off >= deltaBuf.length) throw new Error('delta copy truncated');
          copySize += deltaBuf[off++] * 2 ** ((bit - 4) * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > baseBuf.length || written + copySize > targetSize) {
        throw new Error('delta copy out of range');
      }
      baseBuf.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const len = op & 0x7f;
      if (off + len > deltaBuf.length || written + len > targetSize) {
        throw new Error('delta insert out of range');
      }
      deltaBuf.copy(out, written, off, off + len);
      off += len;
      written += len;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

const PACK_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate one zlib stream starting at `offset`; reports the bytes and the offset past the stream. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

function readPackHeader(buf: Buffer, start: number): { size: number; first: number; next: number } {
  if (start >= buf.length) throw new Error('pack entry header truncated');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while ((byte & 0x80) !== 0) {
    if (off >= buf.length) throw new Error('pack entry size varint truncated');
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, first, next: off };
}

function readOfsBase(buf: Buffer, start: number): { distance: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta base offset truncated');
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (off >= buf.length) throw new Error('ofs-delta base offset truncated');
    byte = buf[off++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: off };
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (version 2 or 3), resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` supplies a base a thin pack leaves out. Throws on any
 * corruption, including a trailer checksum mismatch. Returns the resolved
 * objects keyed by their recomputed ids.
 */
export function readPack(pack: Uint8Array, resolveBase?: Lookup): Map<string, GitObject> {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack without PACK magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerAt = buf.length - 20;
  const trailer = buf.subarray(trailerAt).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerAt)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const header = readPackHeader(buf, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buf, off);
      off = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) throw new Error('ofs-delta with an invalid base offset');
      entry.baseOffset = entryOffset - base.distance;
    } else if (typeCode === 7) {
      if (off + 20 > trailerAt) throw new Error('ref-delta base id truncated');
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!PACK_CODE_TYPE[typeCode]) {
      throw new Error(`pack entry with unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerAt), off);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerAt) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done) return done;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const inPack = resolvedByOid.get(wanted);
      if (inPack) {
        const base = resolve(inPack);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = PACK_CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };

  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function packEntryHeader(type: ObjType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile of whole objects (no deltas), with a correct trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;
const PKT_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem = string | Buffer | 'flush' | 'delim';

/** Encode one data packet: 4 hex length bytes, then the payload. */
export function pktEncode(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

/** Encode a sequence of packets; 'flush'/'delim' are the control packets. */
export function pktEncodeMany(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktEncode(item));
  }
  return Buffer.concat(parts);
}

export type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from the front of `buf`, stopping at the first flush
 * packet (or the end of the buffer). Returns the packets and the offset just
 * past the flush, so a caller whose body continues with raw bytes (a push's
 * packfile) knows where the framing ends.
 */
export function pktDecodePrefix(buf: Buffer): { packets: DecodedPacket[]; consumed: number } {
  const packets: DecodedPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const headText = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(headText)) throw new Error(`invalid pkt-line length ${JSON.stringify(headText)}`);
    const len = parseInt(headText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      return { packets, consumed: off + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || len > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes in pkt-line stream');
  return { packets, consumed: off };
}

/** The text lines of data packets, control packets dropped. */
export function pktLines(packets: readonly DecodedPacket[]): string[] {
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  return lines;
}

/**
 * Wrap raw bytes in sideband packets of one band, each chunked so the framed
 * packet stays within the pkt-line maximum. Band 1 carries pack data or a
 * report stream; band 2 carries progress text.
 */
export function sidebandWrap(band: 1 | 2, data: Buffer): Buffer {
  const maxData = PKT_MAX_PAYLOAD - 1; // one byte for the band
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += maxData) {
    const chunk = data.subarray(off, Math.min(data.length, off + maxData));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktEncode(payload));
  }
  if (data.length === 0) parts.push(pktEncode(Buffer.from([band])));
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// Reachability, ancestry, and tree operations
// -------------------------------------------------------------------------------------------

/** Every object reachable from `roots` (missing objects skipped). */
export function reachable(lookup: Lookup, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue; // gitlink: a commit this repo does not hold
        queue.push(e.oid);
      }
    }
  }
  return seen;
}

export interface FetchPlan {
  /** Object ids to send, sorted for deterministic packs. */
  readonly objects: string[];
  /** Commits that become the client's new shallow boundary. */
  readonly shallow: string[];
  /** Client shallow boundaries that are no longer shallow after this fetch. */
  readonly unshallow: string[];
}

/**
 * Plan a fetch: the closure of `wants` minus what `haves` already cover,
 * cut at `depth` commit generations when given. A commit is shallow when it
 * is included but one of its parents is neither included nor already held.
 * `oldShallow` names the client's current boundary, for deepen requests.
 */
/** The closure the client already holds: the reachable closure of its haves,
 *  except that traversal stops at the old shallow boundary. A shallow client
 *  holds a boundary commit and its content, but not the commit's parents, so
 *  treating the boundary as a full-history have would swallow exactly the
 *  generation a deepen is asking for. */
function heldClosure(lookup: Lookup, haves: readonly string[], oldShallow: readonly string[]): Set<string> {
  const boundary = new Set(oldShallow);
  const held = new Set<string>();
  const queue: string[] = [];
  const queued = new Set<string>();
  for (const oid of haves) {
    if (isOid(oid) && !queued.has(oid)) {
      queued.add(oid);
      queue.push(oid);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (held.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (!queued.has(c.tree)) {
        queued.add(c.tree);
        queue.push(c.tree);
      }
      if (!boundary.has(oid)) {
        for (const p of c.parents) {
          if (!queued.has(p)) {
            queued.add(p);
            queue.push(p);
          }
        }
      }
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!queued.has(target)) {
        queued.add(target);
        queue.push(target);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        if (!queued.has(e.oid)) {
          queued.add(e.oid);
          queue.push(e.oid);
        }
      }
    }
  }
  return held;
}

export function planFetch(
  lookup: Lookup,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
): FetchPlan {
  const held = heldClosure(lookup, haves, oldShallow);
  const included = new Set<string>();
  const commitParents = new Map<string, readonly string[]>();
  // Queue entries carry the commit generation (0 = a want). Trees, blobs and
  // tag targets ride at generation -1: depth limits commits, not content.
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) if (isOid(want)) queue.push({ oid: want, gen: 0 });
  const queued = new Set<string>(queue.map((q) => q.oid));
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (included.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    // A held object is not sent, but it is still EXPANDED: the parents of a
    // held shallow-boundary commit are exactly what a deepen asks for, and
    // skipping expansion there would swallow the whole deepen payload.
    const isHeld = held.has(oid);
    if (!isHeld) included.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (!isHeld) commitParents.set(oid, c.parents);
      if (!queued.has(c.tree)) {
        queued.add(c.tree);
        queue.push({ oid: c.tree, gen: -1 });
      }
      if (depth === undefined || gen + 1 < depth) {
        for (const p of c.parents) {
          if (!queued.has(p)) {
            queued.add(p);
            queue.push({ oid: p, gen: gen + 1 });
          }
        }
      }
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!queued.has(target)) {
        queued.add(target);
        queue.push({ oid: target, gen });
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        if (!queued.has(e.oid)) {
          queued.add(e.oid);
          queue.push({ oid: e.oid, gen: -1 });
        }
      }
    }
  }

  const shallow: string[] = [];
  for (const [oid, parents] of commitParents) {
    if (parents.length === 0) continue;
    const cut = parents.some((p) => !included.has(p) && !held.has(p));
    if (cut) shallow.push(oid);
  }
  shallow.sort();

  const unshallow: string[] = [];
  for (const oid of oldShallow) {
    // A boundary commit is unshallowed when every parent is now on the
    // client's side, whether this fetch delivered it or the client already
    // held it. The boundary commit itself need not be re-sent.
    if (!included.has(oid) && !held.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => included.has(p) || held.has(p))) unshallow.push(oid);
  }
  unshallow.sort();

  return { objects: [...included].sort(), shallow, unshallow };
}

/** True when `ancestor` is reachable from `descendant` by following parents. */
export function isAncestor(lookup: Lookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) stack.push(p);
    }
  }
  return false;
}

/** The merge-base of two commits: the closest common ancestor to `b`. Null when histories are disjoint. */
export function mergeBase(lookup: Lookup, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsA.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    ancestorsA.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** A flat path -> entry view of a tree, cached: trees are immutable, so the flattening never goes stale. */
export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

const flatCache = new Map<string, Map<string, FlatEntry>>();

export function flattenTree(lookup: Lookup, treeOid: string): Map<string, FlatEntry> {
  const cached = flatCache.get(treeOid);
  if (cached) return cached;
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  if (flatCache.size > 20000) flatCache.clear();
  flatCache.set(treeOid, out);
  return out;
}

export interface TreeDiffEntry {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** The path-level difference between two flattened trees, in path order. */
export function diffFlat(base: Map<string, FlatEntry>, head: Map<string, FlatEntry>): TreeDiffEntry[] {
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: TreeDiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

export type MergeOutcome = { merged: Map<string, FlatEntry> } | { conflict: string };

/**
 * A whole-file three-way merge: a path both sides changed differently from
 * the base is a conflict; every other path resolves to the side that moved.
 */
export function mergeFlat(
  base: Map<string, FlatEntry>,
  ours: Map<string, FlatEntry>,
  theirs: Map<string, FlatEntry>,
): MergeOutcome {
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, FlatEntry>();
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const bOid = b?.oid ?? null;
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (oOid === tOid) {
      if (o) merged.set(path, o);
    } else if (oOid === bOid) {
      if (t) merged.set(path, t);
    } else if (tOid === bOid) {
      if (o) merged.set(path, o);
    } else {
      return { conflict: path };
    }
  }
  return { merged };
}

/** Rebuild nested tree objects from a flat path map, storing each tree; returns the root tree id. */
export function buildTreeFromFlat(
  flat: Map<string, FlatEntry>,
  store: (type: ObjType, data: Buffer) => string,
): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of [...flat.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push({ mode: entry.mode, name: parts[parts.length - 1], oid: entry.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    return store('tree', data);
  };
  return build(root);
}

/** Line counts for a changed file: LCS-based additions/deletions. */
export function countLineDiff(oldBytes: Buffer | null, newBytes: Buffer | null): { additions: number; deletions: number } {
  const split = (b: Buffer): string[] => {
    const text = b.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = oldBytes ? split(oldBytes) : [];
  const b = newBytes ? split(newBytes) : [];
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // Two-row LCS; suite blobs are small (tens of lines at most).
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[b.length];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}
