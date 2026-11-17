// Git object model, packfiles and the pkt-line codec, implemented from the protocol's own
// definitions on Node's standard library only (node:crypto for SHA-1, node:zlib for deflate).
// Objects are stored whole (never delta-compressed on the wire out), which the protocol allows:
// a pack may carry every object in full.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of a typed payload: sha1("<type> <length>\0" + payload). */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- commits

export interface CommitParts {
  readonly tree: string;
  readonly parents: readonly string[];
  /** The full author line after "author ", e.g. "Name <mail> 1700000000 +0000". */
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit payload; tolerant of extra headers (gpgsig etc. are skipped). */
export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(parts: CommitParts): Buffer {
  let out = `tree ${parts.tree}\n`;
  for (const parent of parts.parents) out += `parent ${parent}\n`;
  out += `author ${parts.author}\ncommitter ${parts.committer}\n\n${parts.message}`;
  return Buffer.from(out, 'utf8');
}

/** The unix timestamp inside an ident line ("... 1700000000 +0000"), or null. */
export function identTimestamp(ident: string): number | null {
  const match = / (\d+) [+-]\d{4}$/.exec(ident.trim());
  return match === null ? null : Number(match[1]);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte-wise by name, with directories sorting as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface TagParts {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = ZERO_OID;
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

/** Inflate one zlib stream starting at `offset`; returns the payload and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta payload to a base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size (the caller checks the result size instead)
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset] ?? 0; offset += 1; }
      if (op & 0x02) { copyOffset |= (delta[offset] ?? 0) << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= (delta[offset] ?? 0) << 24; offset += 1; }
      if (op & 0x10) { copySize = delta[offset] ?? 0; offset += 1; }
      if (op & 0x20) { copySize |= (delta[offset] ?? 0) << 8; offset += 1; }
      if (op & 0x40) { copySize |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('pack delta: opcode 0 is reserved');
    }
  }
  const joined = Buffer.concat(out);
  if (joined.length !== resultSize || produced !== resultSize) throw new Error('pack delta: size mismatch');
  return joined;
}

interface PendingDelta {
  readonly kind: 'ofs' | 'ref';
  readonly baseOid?: string;
  readonly baseOffset?: number;
  readonly delta: Buffer;
  readonly offset: number;
}

/**
 * Read a whole packfile into `objects` (keyed by oid). Deltas (ofs and ref) are resolved against
 * objects already in the map or earlier in the same pack. Returns the object count from the header.
 * Throws on any malformed input; the caller turns that into an unpack error.
 */
export function readPack(pack: Buffer, objects: Map<string, GitObject>): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('pack: bad signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: unsupported version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  let offset = 12;
  const offsetToOid = new Map<number, string>();
  const pending: PendingDelta[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    // The size varint is not needed: the zlib stream that follows is self-terminating.
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] ?? 0;
      offset += 1;
    }
    if (typeCode === 6) {
      // ofs-delta: a negative offset varint back to the base object's start.
      let back = 0;
      let b = pack[offset] ?? 0;
      offset += 1;
      back = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset] ?? 0;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
      offset = inflated.next;
      pending.push({ kind: 'ofs', baseOffset: start - back, delta: inflated.data, offset: start });
    } else if (typeCode === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
      offset = inflated.next;
      pending.push({ kind: 'ref', baseOid, delta: inflated.data, offset: start });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`pack: unknown object type ${typeCode}`);
      const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
      offset = inflated.next;
      const oid = hashObject(type, inflated.data);
      objects.set(oid, { type, data: inflated.data });
      offsetToOid.set(start, oid);
    }
  }
  // Resolve deltas; a delta's base may itself be a delta later in the pack, so loop until settled.
  let remaining = pending;
  let guard = 0;
  while (remaining.length > 0) {
    guard += 1;
    if (guard > count + 2) throw new Error('pack: delta chain does not resolve');
    const deferred: PendingDelta[] = [];
    for (const item of remaining) {
      const baseOid = item.kind === 'ref' ? (item.baseOid as string) : offsetToOid.get(item.baseOffset as number);
      const base = baseOid === undefined ? undefined : objects.get(baseOid);
      if (base === undefined || baseOid === undefined) {
        deferred.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      offsetToOid.set(item.offset, oid);
    }
    if (deferred.length === remaining.length) throw new Error('pack: delta base missing');
    remaining = deferred;
  }
  return count;
}

/** Write a packfile carrying every object in full (no deltas), with the SHA-1 trailer. */
export function writePack(objects: readonly (GitObject & { readonly oid: string })[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    const first = (TYPE_CODES[object.type] << 4) | (size & 0x0f);
    const bytes: number[] = [];
    let rest = size >> 4;
    if (rest > 0) {
      bytes.push(first | 0x80);
      while (rest > 0) {
        let b = rest & 0x7f;
        rest >>= 7;
        if (rest > 0) b |= 0x80;
        bytes.push(b);
      }
    } else {
      bytes.push(first);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'latin1'), data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'latin1');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'latin1');
}

export type PktToken =
  | { readonly kind: 'line'; readonly data: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' };

/** Parse pkt-lines from `offset`; returns the tokens and the offset of the first unparsed byte. */
export function parsePktLines(buffer: Buffer, offset: number): { tokens: PktToken[]; next: number } {
  const tokens: PktToken[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const length = Number.parseInt(buffer.toString('latin1', at, at + 4), 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) {
      tokens.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (length === 1) {
      tokens.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) break;
    tokens.push({ kind: 'line', data: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { tokens, next: at };
}
