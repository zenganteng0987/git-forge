// The forge's in-memory state: repositories with their own git object stores, refs, and the
// issue / pull-request records the REST, GraphQL and MCP surfaces share. One store serves every
// surface, so an object or issue created through one is visible through all the others.
//
// The scenario the suite drives names exactly one repository owner (its viewer), but the forge is
// never told that login in advance. The store therefore keeps a single owner slot: the first
// owner-bearing request binds it, and from then on a repository addressed under any other owner
// does not exist (GitHub answers 404 for a repo you cannot see, never 403).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';

export const FORGE_IDENT = 'Forge <forge@localhost>';
/** Logical epoch the forge's own timestamps derive from; a per-repo counter keeps them ordered. */
const EPOCH_SEC = 1_700_000_000;

export interface CommentRec {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface IssueRec {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: CommentRec[];
  readonly isPull: boolean;
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
  readonly createdAtSec: number;
  mergedAtSec: number | null;
}

export interface RepoRec {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, IssueRec>;
  readonly labels: Map<string, string>;
  nextNumber: number;
  clock: number;
  readonly createdAtSec: number;
  /** Memoised git-protocol responses, keyed by state fingerprint + request (see gitproto.ts). */
  readonly httpCache: Map<string, Buffer>;
  httpCacheBytes: number;
}

export class Store {
  readonly repos = new Map<string, RepoRec>();
  viewerLogin: string | null = null;
  private nextRepoId = 1;
  private nextCommentId = 1;
  private seq = 0;

  /** Bind the owner slot on first sight; returns the effective viewer login. */
  bindOwner(login: string): string {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
    return this.viewerLogin ?? login;
  }

  /** The next global creation-order stamp (issues, comments). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextComment(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /**
   * Look a repository up by owner + name. An owner that is not the bound viewer sees nothing.
   * When the slot is still free, the lookup itself binds it.
   */
  repo(owner: string, name: string): RepoRec | null {
    if (this.viewerLogin === null) this.bindOwner(owner);
    if (owner !== this.viewerLogin) return null;
    return this.repos.get(name) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      labels: new Map(),
      nextNumber: 1,
      clock: 0,
      createdAtSec: EPOCH_SEC + this.nextRepoId,
      httpCache: new Map(),
      httpCacheBytes: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Advance the repo's logical clock and return the new timestamp (seconds). */
  tick(repo: RepoRec): number {
    repo.clock += 1;
    return EPOCH_SEC + repo.clock;
  }
}

/** An ISO-8601 timestamp from logical seconds. */
export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** The forge's own ident line at a logical time. */
export function identAt(sec: number): string {
  return `${FORGE_IDENT} ${sec} +0000`;
}

// ---------------------------------------------------------------- object graph helpers

export function getCommit(repo: RepoRec, oid: string) {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Peel a tag chain to the commit it ultimately names; null when it does not end at a commit. */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every object reachable from the given tips (commits walk parents, trees walk entries). */
export function closureOf(repo: RepoRec, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commits reachable from tips, in breadth-first order (tips first). */
export function commitClosure(repo: RepoRec, tips: readonly string[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier = [...tips];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      seen.add(oid);
      order.push(oid);
      next.push(...commit.parents);
    }
    frontier = next;
  }
  return order;
}

/**
 * The commits within `depth` generations of the tips (depth 1 = the tips only), plus the boundary:
 * commits at exactly that depth which still have parents in the store.
 */
export function commitsWithinDepth(
  repo: RepoRec,
  tips: readonly string[],
  depth: number,
): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  let frontier = [...new Set(tips)];
  for (let level = 1; level <= depth; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (commits.has(oid)) continue;
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      commits.add(oid);
      if (level === depth) {
        if (commit.parents.length > 0) boundary.add(oid);
      } else {
        next.push(...commit.parents);
      }
    }
    frontier = next;
  }
  return { commits, boundary };
}

/** Generation distance (shortest, in commits) from any tip to each reachable commit. */
export function commitDistances(repo: RepoRec, tips: readonly string[]): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier = [...new Set(tips)];
  let level = 1;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (distance.has(oid)) continue;
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      distance.set(oid, level);
      next.push(...commit.parents);
    }
    frontier = next;
    level += 1;
  }
  return distance;
}

/** The merge-base of two commits: their first common ancestor in breadth-first order from b. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = new Set(commitClosure(repo, [a]));
  for (const candidate of commitClosure(repo, [b])) {
    if (ancestorsOfA.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Is `ancestor` reachable from `descendant` (a fast-forward check)? Breadth-first from the
 * descendant, stopping the moment the ancestor is visited: the usual case (the old tip is the
 * new tip's parent, or a few generations back) costs a handful of commit parses instead of a
 * walk over the whole history. The answer is unchanged — it is membership in the same closure
 * `commitClosure` would build, tested as each commit is first reached.
 */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  let frontier = [descendant];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      seen.add(oid);
      if (oid === ancestor) return true;
      next.push(...commit.parents);
    }
    frontier = next;
  }
  return false;
}

// ---------------------------------------------------------------- trees and files

/** Flatten a tree (recursively) into path -> {oid, mode}. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Resolve a path inside a tree to its entry, or null. */
export function treePath(repo: RepoRec, treeOid: string, segments: readonly string[]): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    current = entry.oid;
  }
  return null;
}

/** Put a blob and rebuild the trees along `segments`; returns the new root tree oid. */
export function setFileInTree(
  repo: RepoRec,
  rootTreeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
): string {
  const build = (treeOid: string | null, depth: number): string => {
    const entries: TreeEntry[] = treeOid === null
      ? []
      : parseTree((repo.objects.get(treeOid) as GitObject).data).map((entry) => ({ mode: entry.mode, name: entry.name, oid: entry.oid }));
    const name = segments[depth] as string;
    const at = entries.findIndex((entry) => entry.name === name);
    if (depth === segments.length - 1) {
      if (blobOid === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const childOid = at >= 0 ? entries[at]?.oid ?? null : null;
      const newChild = build(childOid, depth + 1);
      if (at >= 0) entries[at] = { mode: '40000', name, oid: newChild };
      else entries.push({ mode: '40000', name, oid: newChild });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(rootTreeOid, 0);
}

/** Create a commit on top of `parent` (or a root commit) authored by the forge; returns its oid. */
export function forgeCommit(
  repo: RepoRec,
  treeOid: string,
  parent: string | null,
  message: string,
): string {
  const at = EPOCH_SEC + (repo.clock += 1);
  const data = buildCommit({
    tree: treeOid,
    parents: parent === null ? [] : [parent],
    author: identAt(at),
    committer: identAt(at),
    message,
  });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** Build a root tree oid from a flattened path map (blobs must already be in the store). */
export function buildTreeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  const buildLevel = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) dirs.add(rest.slice(0, slash));
    }
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes('/')) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
    }
    for (const dir of dirs) {
      entries.push({ mode: '40000', name: dir, oid: buildLevel(`${prefix}${dir}/`) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return buildLevel('');
}

/**
 * The tree a merge of `headTip` into `baseTip` would produce: a file-level three-way merge
 * against the merge-base. A path both sides changed differently (or one side deleted while the
 * other changed) is a conflict and answers null.
 */
export function mergedTreeOf(repo: RepoRec, headTip: string, baseTip: string): string | null {
  const base = mergeBase(repo, headTip, baseTip);
  const headCommit = getCommit(repo, headTip);
  const baseCommit = getCommit(repo, baseTip);
  if (headCommit === null || baseCommit === null) return null;
  const baseFiles = base === null
    ? new Map<string, { oid: string; mode: string }>()
    : flattenTree(repo, (getCommit(repo, base) as { tree: string }).tree);
  const headFiles = flattenTree(repo, headCommit.tree);
  const baseBranchFiles = flattenTree(repo, baseCommit.tree);
  const same = (a?: { oid: string; mode: string }, b?: { oid: string; mode: string }): boolean => a?.oid === b?.oid && a?.mode === b?.mode;
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseBranchFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    const inBranch = baseBranchFiles.get(path);
    let chosen: { oid: string; mode: string } | undefined;
    if (same(inHead, inBranch)) chosen = inHead;
    else if (same(inBase, inHead)) chosen = inBranch;
    else if (same(inBase, inBranch)) chosen = inHead;
    else return null;
    if (chosen !== undefined) merged.set(path, chosen);
  }
  return buildTreeFromFlat(repo, merged);
}
