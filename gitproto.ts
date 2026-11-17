// The git smart-HTTP protocol: ref advertisement, ls-refs and fetch over protocol v2 (with the
// v0 fetch fallback), and receive-pack in v0. Objects travel in packfiles written by gitobj.ts;
// refs and objects live in the per-repo store. The implementations follow the protocol as the
// suite's own client speaks it: pkt-line framing, side-band-64k for pack data, shallow/deepen
// negotiation, and report-status for pushes.

import {
  ZERO_OID,
  identTimestamp,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import {
  closureOf,
  commitClosure,
  commitDistances,
  commitsWithinDepth,
  getCommit,
  isAncestor,
  peelToCommit,
  type RepoRec,
} from './store.ts';

export const AGENT = 'forge/1.0';
const UPLOAD_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta deepen-since deepen-not deepen-relative';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';
const SIDE_BAND_CHUNK = 65_000;

// ---------------------------------------------------------------- ref listing

export interface RefEntry {
  readonly name: string;
  readonly oid: string;
}

/** Every ref in the repo, sorted by name (the order both protocol versions advertise). */
export function sortedRefs(repo: RepoRec): RefEntry[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Peel a (possibly annotated) tag to the non-tag object it names; null when not a tag. */
export function peeledTarget(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current === oid ? null : current;
    current = parseTag(object.data).object;
  }
  return null;
}

/** The oid HEAD names: the default branch's tip, or null on an unborn branch. */
export function headOid(repo: RepoRec): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------- advertisement

/** The info/refs body for one service. Protocol v2 is answered only for upload-pack. */
export function advertise(repo: RepoRec, service: string, version2: boolean): { body: Buffer; contentType: string } {
  const preamble = Buffer.concat([pktLine(`# service=${service}\n`), pktFlush()]);
  if (version2 && service === 'git-upload-pack') {
    const lines = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow filter\n',
      'object-format=sha1\n',
    ];
    return {
      body: Buffer.concat([preamble, ...lines.map((line) => pktLine(line)), pktFlush()]),
      contentType: 'application/x-git-upload-pack-advertisement',
    };
  }
  const caps = service === 'git-receive-pack' ? `${RECEIVE_CAPS} agent=${AGENT}` : `${UPLOAD_CAPS} agent=${AGENT}`;
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}`, 'utf8')])));
  } else {
    const first = head ?? refs[0]?.oid ?? ZERO_OID;
    lines.push(pktLine(Buffer.concat([Buffer.from(`${first} HEAD\0${caps}`, 'utf8')])));
    for (const ref of refs) {
      lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledTarget(repo, ref.oid);
      if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  return {
    body: Buffer.concat([preamble, ...lines, pktFlush()]),
    contentType: service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
  };
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 command request body: command lines, a delimiter, then argument lines to a flush. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { tokens } = parsePktLines(body, 0);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const token of tokens) {
    if (token.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (token.kind === 'flush') break;
    const text = token.data.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

export function handleLsRefs(repo: RepoRec, body: Buffer): Buffer {
  const { args } = parseV2Request(body);
  const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const arg of args) {
    if (arg === 'peel') parsed.peel = true;
    else if (arg === 'symrefs') parsed.symrefs = true;
    else if (arg === 'unborn') parsed.unborn = true;
    else if (arg.startsWith('ref-prefix ')) parsed.prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    parsed.prefixes.length === 0 || parsed.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const head = headOid(repo);
  const headWanted = parsed.prefixes.length === 0 || parsed.prefixes.some((prefix) => 'HEAD'.startsWith(prefix) || prefix.startsWith('HEAD'));
  if (headWanted) {
    if (head !== null) {
      let line = `${head} HEAD`;
      if (parsed.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      lines.push(pktLine(`${line}\n`));
    } else if (parsed.unborn) {
      let line = 'unborn HEAD';
      if (parsed.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      lines.push(pktLine(`${line}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (parsed.symrefs && ref.name.startsWith('refs/heads/')) {
      // Only HEAD carries a symref-target in this forge; branch refs are direct.
    }
    if (parsed.peel) {
      const peeled = peeledTarget(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  return Buffer.concat([...lines, pktFlush()]);
}

// ---------------------------------------------------------------- fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  deepen: number | null;
  deepenRelative: boolean;
  deepenSince: number | null;
  deepenNot: string | null;
  filter: string | null;
  done: boolean;
}

function emptyFetchArgs(): FetchArgs {
  return {
    wants: [],
    haves: [],
    clientShallow: [],
    depth: null,
    deepen: null,
    deepenRelative: false,
    deepenSince: null,
    deepenNot: null,
    filter: null,
    done: false,
  };
}

function applyFetchArg(out: FetchArgs, text: string): void {
  if (text.startsWith('want ')) out.wants.push(text.slice(5).trim());
  else if (text.startsWith('have ')) out.haves.push(text.slice(5).trim());
  else if (text.startsWith('shallow ')) out.clientShallow.push(text.slice(8).trim());
  else if (text.startsWith('deepen ')) out.deepen = Number(text.slice(7).trim());
  else if (text.startsWith('deepen-since ')) out.deepenSince = Number(text.slice(13).trim());
  else if (text.startsWith('deepen-not ')) out.deepenNot = text.slice(11).trim();
  else if (text === 'deepen-relative') out.deepenRelative = true;
  else if (text.startsWith('filter ')) out.filter = text.slice(7).trim();
  else if (text === 'done') out.done = true;
}

/** Object closure that stops at the client's shallow boundary commits (their parents stay home). */
function heldClosure(repo: RepoRec, haves: readonly string[], stopAt: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!stopAt.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Object closure of a shallow window: the window commits plus their trees and blobs, no parents. */
function windowClosure(repo: RepoRec, commits: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const oid of commits) {
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    seen.add(oid);
    stack.push(commit.tree);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

export interface FetchSelection {
  objects: (GitObject & { oid: string })[];
  shallow: string[];
  unshallow: string[];
}

/** Decide which objects a fetch sends, and the shallow/unshallow lines that go with them. */
export function selectFetchObjects(repo: RepoRec, args: FetchArgs): FetchSelection {
  const wantCommits: string[] = [];
  const wantOthers: string[] = [];
  for (const want of new Set(args.wants)) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') wantCommits.push(want);
    else if (object.type === 'tag') {
      const commit = peelToCommit(repo, want);
      if (commit !== null) wantCommits.push(commit);
      wantOthers.push(want);
    } else {
      wantOthers.push(want);
    }
  }
  const shallowMode = args.depth !== null || args.deepen !== null || args.deepenRelative || args.deepenSince !== null || args.deepenNot !== null;
  const stopAt = new Set(args.clientShallow);
  const exclude = shallowMode && (args.deepen !== null || args.deepenRelative || args.deepenSince !== null || args.deepenNot !== null)
    ? heldClosure(repo, args.haves, stopAt)
    : closureOf(repo, args.haves);

  let include: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];

  if (args.deepenSince !== null) {
    const since = args.deepenSince;
    const reachable = commitClosure(repo, wantCommits);
    const included = new Set<string>();
    for (const oid of reachable) {
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      const at = identTimestamp(commit.committer) ?? identTimestamp(commit.author) ?? 0;
      if (at > since) included.add(oid);
    }
    const boundary = new Set<string>();
    for (const oid of included) {
      const commit = getCommit(repo, oid);
      if (commit !== null && commit.parents.some((parent) => !included.has(parent) && repo.objects.has(parent))) boundary.add(oid);
    }
    include = windowClosure(repo, included);
    shallow = [...boundary].sort();
    unshallow = args.clientShallow.filter((oid) => included.has(oid) && !boundary.has(oid)).sort();
  } else if (args.deepenNot !== null) {
    const notTip = repo.refs.get(args.deepenNot) ?? (repo.objects.has(args.deepenNot) ? args.deepenNot : null);
    const excludedCommits = new Set(notTip === null ? [] : commitClosure(repo, [peelToCommit(repo, notTip) ?? notTip]));
    const window = commitClosure(repo, wantCommits).filter((oid) => !excludedCommits.has(oid));
    const windowSet = new Set(window);
    const boundary = new Set<string>();
    for (const oid of window) {
      const commit = getCommit(repo, oid);
      if (commit !== null && commit.parents.some((parent) => !windowSet.has(parent) && repo.objects.has(parent))) boundary.add(oid);
    }
    include = windowClosure(repo, windowSet);
    shallow = [...boundary].sort();
    unshallow = args.clientShallow.filter((oid) => windowSet.has(oid) && !boundary.has(oid)).sort();
  } else if (args.depth !== null || args.deepen !== null || args.deepenRelative) {
    let totalDepth = args.depth ?? args.deepen ?? 1;
    if (args.deepenRelative) {
      const distances = commitDistances(repo, wantCommits);
      let base = 1;
      for (const oid of args.clientShallow) base = Math.max(base, distances.get(oid) ?? 1);
      totalDepth = base + (args.deepen ?? 1);
    }
    const { commits, boundary } = commitsWithinDepth(repo, wantCommits, Math.max(1, totalDepth));
    include = windowClosure(repo, commits);
    shallow = [...boundary].sort();
    unshallow = args.clientShallow.filter((oid) => commits.has(oid) && !boundary.has(oid)).sort();
  } else {
    include = closureOf(repo, [...wantCommits, ...wantOthers]);
  }

  for (const oid of wantOthers) include.add(oid);
  let oids = [...include].filter((oid) => !exclude.has(oid));

  if (args.filter !== null) {
    const spec = args.filter;
    if (spec === 'blob:none') {
      oids = oids.filter((oid) => repo.objects.get(oid)?.type !== 'blob');
    } else if (spec.startsWith('blob:limit=')) {
      const raw = spec.slice('blob:limit='.length);
      const match = /^(\d+)([kmg])?$/.exec(raw);
      if (match !== null) {
        let limit = Number(match[1]);
        if (match[2] === 'k') limit *= 1024;
        else if (match[2] === 'm') limit *= 1024 * 1024;
        else if (match[2] === 'g') limit *= 1024 * 1024 * 1024;
        oids = oids.filter((oid) => {
          const object = repo.objects.get(oid);
          return object === undefined || object.type !== 'blob' || object.data.length <= limit;
        });
      }
    }
  }

  const typeOrder: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const objects = oids
    .map((oid) => ({ oid, ...(repo.objects.get(oid) as GitObject) }))
    .sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || (a.oid < b.oid ? -1 : 1));
  return { objects, shallow, unshallow };
}

/** Wrap pack bytes in side-band-64k pkt-lines (band 1), ending with a flush. */
function sideBandWrap(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < pack.length; at += SIDE_BAND_CHUNK) {
    const chunk = pack.subarray(at, Math.min(pack.length, at + SIDE_BAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The fetch response for protocol v2. */
export function handleFetchV2(repo: RepoRec, body: Buffer): Buffer {
  const { args: rawArgs } = parseV2Request(body);
  const args = emptyFetchArgs();
  for (const raw of rawArgs) applyFetchArg(args, raw);
  const selection = selectFetchObjects(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  const knownHave = args.haves.find((have) => {
    const object = repo.objects.get(have);
    return object !== undefined && object.type === 'commit';
  });
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(knownHave !== undefined ? `ACK ${knownHave} ready\n` : 'NAK\n'));
    parts.push(pktFlush());
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideBandWrap(pack));
  return Buffer.concat(parts);
}

/** Every pkt-line payload in a v0 request, across its flush-separated sections. */
function allPktPayloads(body: Buffer): Buffer[] {
  const payloads: Buffer[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const length = Number.parseInt(body.toString('latin1', at, at + 4), 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0 || length === 1) {
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) break;
    payloads.push(body.subarray(at + 4, at + length));
    at += length;
  }
  return payloads;
}

/** The fetch response for protocol v0: shallow lines, an ACK/NAK line, then the side-band pack. */
export function handleFetchV0(repo: RepoRec, body: Buffer): Buffer {
  const args = emptyFetchArgs();
  // v0 sends the want section, a flush, then the have section and a flush; both parse the same way.
  for (const data of allPktPayloads(body)) {
    let text = data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    applyFetchArg(args, text);
  }
  const selection = selectFetchObjects(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const knownHave = args.haves.find((have) => repo.objects.get(have)?.type === 'commit');
  parts.push(pktLine(knownHave !== undefined ? `ACK ${knownHave}\n` : 'NAK\n'));
  parts.push(sideBandWrap(pack));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack (v0)

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** The receive-pack response body: report-status, side-band wrapped (the advertisement offers it). */
export function handleReceivePack(repo: RepoRec, body: Buffer): Buffer {
  const { tokens, next } = parsePktLines(body, 0);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const token of tokens) {
    if (token.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (token.kind !== 'line') continue;
    let text = token.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const report = (lines: string[]): Buffer => {
    const payload = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
    return sideBandWrap(payload);
  };
  if (commands.length === 0 && !sawFlush) {
    // Not a pkt-line stream at all: answer a bare unpack error and change nothing.
    return Buffer.concat([pktLine('unpack error\n'), pktFlush()]);
  }
  const pack = sawFlush ? body.subarray(next) : Buffer.alloc(0);
  if (pack.length > 0) {
    try {
      readPack(pack, repo.objects);
    } catch (err) {
      return report([`unpack ${err instanceof Error ? err.message : 'error'}\n`]);
    }
  }
  const lines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    lines.push(`${applyRefUpdate(repo, command)}\n`);
  }
  return report(lines);
}

/** Apply one ref update; returns its report-status line ("ok <ref>" / "ng <ref> <reason>"). */
function applyRefUpdate(repo: RepoRec, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  if (!repo.objects.has(newOid)) return `ng ${ref} reference not found`;
  if (oldOid !== ZERO_OID && oldOid !== current && current !== ZERO_OID) {
    return `ng ${ref} stale info`;
  }
  if (ref.startsWith('refs/heads/') && oldOid !== ZERO_OID && oldOid !== newOid) {
    const newCommit = peelToCommit(repo, newOid);
    if (newCommit === null || !isAncestor(repo, oldOid, newCommit)) {
      return `ng ${ref} non-fast-forward`;
    }
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}
