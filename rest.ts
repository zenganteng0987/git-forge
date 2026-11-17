// The REST v3 surface and the domain operations every surface shares: creating issues and pull
// requests, and merging a pull request with a file-level three-way merge. Serializers produce the
// GitHub-shaped JSON the checks read (repo objects, issue objects with a pull_request marker on
// pull requests, pull objects whose head/base shas resolve live from the branch tips).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './gitobj.ts';
import {
  Store,
  flattenTree,
  forgeCommit,
  getCommit,
  identAt,
  isoOf,
  mergeBase,
  mergedTreeOf,
  peelToCommit,
  setFileInTree,
  treePath,
  type IssueRec,
  type RepoRec,
} from './store.ts';

export interface RestResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const notFound = (): RestResult => ({ status: 404, body: { message: 'Not Found' } });
const validation = (message: string): RestResult => ({ status: 422, body: { message } });

// ---------------------------------------------------------------- serializers

export function viewerOf(store: Store): string {
  return store.viewerLogin ?? 'forge';
}

export function repoJson(store: Store, repo: RepoRec): Record<string, unknown> {
  const owner = viewerOf(store);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User', site_admin: false },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `https://forge.local/${owner}/${repo.name}`,
    clone_url: `https://forge.local/${owner}/${repo.name}.git`,
    git_url: `git://forge.local/${owner}/${repo.name}.git`,
    ssh_url: `git@forge.local:${owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdAtSec),
    updated_at: isoOf(repo.createdAtSec),
    pushed_at: isoOf(repo.createdAtSec),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    language: null,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueJson(store: Store, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const owner = viewerOf(store);
  const base: Record<string, unknown> = {
    id: repo.id * 1_000_000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: owner, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAtSec),
    updated_at: isoOf(issue.createdAtSec),
    closed_at: issue.state === 'closed' ? isoOf(issue.createdAtSec) : null,
    html_url: `https://forge.local/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
  if (issue.isPull) {
    base.pull_request = {
      url: `/api/v3/repos/${owner}/${repo.name}/pulls/${issue.number}`,
      html_url: `https://forge.local/${owner}/${repo.name}/pull/${issue.number}`,
      diff_url: `https://forge.local/${owner}/${repo.name}/pull/${issue.number}.diff`,
      patch_url: `https://forge.local/${owner}/${repo.name}/pull/${issue.number}.patch`,
    };
  }
  return base;
}

export function pullJson(store: Store, repo: RepoRec, pull: IssueRec): Record<string, unknown> {
  const owner = viewerOf(store);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    ref,
    sha,
    label: `${owner}:${ref}`,
    user: { login: owner, id: 1, type: 'User' },
    repo: repoJson(store, repo),
  });
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    merged: pull.merged,
    merged_at: pull.merged && pull.mergedAtSec !== null ? isoOf(pull.mergedAtSec) : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, id: 1, type: 'User' },
    created_at: isoOf(pull.createdAtSec),
    updated_at: isoOf(pull.createdAtSec),
    closed_at: pull.state === 'closed' || pull.merged ? isoOf(pull.createdAtSec) : null,
    html_url: `https://forge.local/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    merged_by: pull.merged ? { login: owner, id: 1, type: 'User' } : null,
  };
}

export function commentJson(store: Store, comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: viewerOf(store), id: 1, type: 'User' },
    created_at: isoOf(1_700_000_000 + comment.createdSeq),
    updated_at: isoOf(1_700_000_000 + comment.createdSeq),
  };
}

// ---------------------------------------------------------------- domain operations

export class DomainError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createIssueRecord(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; labels?: readonly string[] },
): IssueRec {
  const labels: string[] = [];
  for (const name of input.labels ?? []) {
    const canonical = repo.labels.get(name.toLowerCase());
    if (canonical === undefined) throw new DomainError(422, `Validation Failed: label "${name}" does not exist`);
    labels.push(canonical);
  }
  const issue: IssueRec = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    isPull: false,
    headRef: '',
    baseRef: '',
    merged: false,
    mergeCommitSha: null,
    createdSeq: store.nextSeq(),
    createdAtSec: 1_700_000_000 + repo.nextNumber,
    mergedAtSec: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRecord(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base?: string },
): IssueRec {
  const stripOwner = (ref: string): string => (ref.includes(':') ? (ref.split(':').pop() as string) : ref);
  const head = stripOwner(input.head);
  const base = stripOwner(input.base ?? repo.defaultBranch);
  if (!repo.refs.has(`refs/heads/${head}`)) throw new DomainError(422, 'Validation Failed: head branch does not exist');
  if (!repo.refs.has(`refs/heads/${base}`)) throw new DomainError(422, 'Validation Failed: base branch does not exist');
  for (const existing of repo.issues.values()) {
    if (existing.isPull && existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      throw new DomainError(422, 'Validation Failed: a pull request already exists for this branch combination');
    }
  }
  const pull: IssueRec = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [],
    comments: [],
    isPull: true,
    headRef: head,
    baseRef: base,
    merged: false,
    mergeCommitSha: null,
    createdSeq: store.nextSeq(),
    createdAtSec: 1_700_000_000 + repo.nextNumber,
    mergedAtSec: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(pull.number, pull);
  return pull;
}

export type MergeOutcome =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: 'conflict' | 'closed' | 'missing' };

/**
 * Merge a pull request. 'squash' (the default, and what the checks exercise) lands one commit on
 * the base branch whose tree is the file-level three-way merge of head into base against their
 * merge-base; 'merge' lands a two-parent merge commit with the same tree. A path both sides
 * changed differently is a conflict.
 */
export function mergePullRecord(store: Store, repo: RepoRec, pull: IssueRec, method: string): MergeOutcome {
  void store;
  if (pull.merged || pull.state === 'closed') return { ok: false, reason: 'closed' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'missing' };
  const tree = mergedTreeOf(repo, headTip, baseTip);
  if (tree === null) return { ok: false, reason: 'conflict' };
  if (method === 'merge') {
    const at = 1_700_000_000 + (repo.clock += 1);
    const data = buildCommit({
      tree,
      parents: [baseTip, headTip],
      author: identAt(at),
      committer: identAt(at),
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
    });
    const sha = hashObject('commit', data);
    repo.objects.set(sha, { type: 'commit', data });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = sha;
    pull.mergedAtSec = at;
    return { ok: true, sha };
  }
  const message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}\n`;
  const sha = forgeCommit(repo, tree, baseTip, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.mergedAtSec = 1_700_000_000 + repo.clock;
  return { ok: true, sha };
}

// ---------------------------------------------------------------- pagination

interface Page {
  readonly items: unknown[];
  readonly headers: Record<string, string>;
}

function paginate(items: readonly unknown[], query: URLSearchParams, host: string, path: string): Page {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages || totalPages > 1) {
    const url = (p: number): string => `http://${host}${path}?per_page=${perPage}&page=${p}`;
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`<${url(page + 1)}>; rel="next"`);
      links.push(`<${url(totalPages)}>; rel="last"`);
    }
    if (page > 1) {
      links.push(`<${url(page - 1)}>; rel="prev"`);
      links.push(`<${url(1)}>; rel="first"`);
    }
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { items: slice, headers };
}

// ---------------------------------------------------------------- the router

export interface RestRequest {
  readonly method: string;
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown> | null;
  readonly host: string;
  /** The raw path (for pagination Link URLs). */
  readonly path: string;
}

export function handleRest(store: Store, req: RestRequest): RestResult {
  const { method, segments } = req;
  // Root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_url: '/api/v3/repos/{owner}/{repo}/issues{/number}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        headers: { 'x-oauth-scopes': 'repo, read:org, write:org' },
      };
    }
    return notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { verifiable_password_authentication: false, installed_version: 'forge-1.0.0', github_services_sha: 'forge' } };
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    if (store.viewerLogin === null) return notFound();
    return { status: 200, body: { login: store.viewerLogin, id: 1, type: 'User', site_admin: false, name: store.viewerLogin } };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') return createRepo(store, req);
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.id - b.id).map((repo) => repoJson(store, repo));
      const page = paginate(all, req.query, req.host, req.path);
      return { status: 200, body: page.items, headers: page.headers };
    }
    return notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.repo(owner, name);
    if (repo === null) return notFound();
    return handleRepo(store, repo, req, segments.slice(3));
  }
  return notFound();
}

function createRepo(store: Store, req: RestRequest): RestResult {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return validation('Repository creation failed: name is required');
  if (store.repos.has(name)) return validation('name already exists on this account');
  const description = typeof body.description === 'string' ? body.description : '';
  const repo = store.createRepo(name, description, body.private === true);
  return { status: 201, body: repoJson(store, repo) };
}

function handleRepo(store: Store, repo: RepoRec, req: RestRequest, rest: readonly string[]): RestResult {
  const { method } = req;
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(store, repo) };
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.defaultBranch = body.default_branch;
      }
      return { status: 200, body: repoJson(store, repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      return { status: 204, body: null };
    }
    return notFound();
  }
  const head = rest[0] as string;
  if (head === 'labels') return handleLabels(store, repo, req, rest);
  if (head === 'issues') return handleIssues(store, repo, req, rest);
  if (head === 'pulls') return handlePulls(store, repo, req, rest);
  if (head === 'contents') return handleContents(store, repo, req, rest);
  if (head === 'git') return handleGitRefs(store, repo, req, rest);
  if (head === 'branches') return handleBranches(store, repo, req, rest);
  if (head === 'commits') return handleCommits(store, repo, req, rest);
  return notFound();
}

function handleLabels(store: Store, repo: RepoRec, req: RestRequest, rest: readonly string[]): RestResult {
  void store;
  if (rest.length === 1 && req.method === 'POST') {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (name === '') return validation('Validation Failed: name is required');
    if (repo.labels.has(name.toLowerCase())) return validation('Validation Failed: label already exists');
    repo.labels.set(name.toLowerCase(), name);
    return { status: 201, body: { id: labelId(name), name, color: 'ededed', default: false, description: null } };
  }
  if (rest.length === 1 && req.method === 'GET') {
    return { status: 200, body: [...repo.labels.values()].map((name) => ({ id: labelId(name), name, color: 'ededed', default: false })) };
  }
  return notFound();
}

function labelId(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function handleIssues(store: Store, repo: RepoRec, req: RestRequest, rest: readonly string[]): RestResult {
  if (rest.length === 1) {
    if (req.method === 'POST') {
      const body = req.body ?? {};
      if (typeof body.title !== 'string' || body.title === '') return validation('Validation Failed: title is required');
      try {
        const issue = createIssueRecord(store, repo, {
          title: body.title,
          body: typeof body.body === 'string' ? body.body : '',
          labels: Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [],
        });
        return { status: 201, body: issueJson(store, repo, issue) };
      } catch (err) {
        if (err instanceof DomainError) return { status: err.status, body: { message: err.message } };
        throw err;
      }
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const ascending = req.query.get('direction') === 'asc';
      const all = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => (ascending ? a.number - b.number : b.number - a.number))
        .map((issue) => issueJson(store, repo, issue));
      const page = paginate(all, req.query, req.host, req.path);
      return { status: 200, body: page.items, headers: page.headers };
    }
    return notFound();
  }
  const number = Number(rest[1]);
  const issue = Number.isSafeInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) return notFound();
  if (rest.length === 2) {
    if (req.method === 'GET') return { status: 200, body: issueJson(store, repo, issue) };
    if (req.method === 'PATCH') {
      const body = req.body ?? {};
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels: string[] = [];
        for (const name of body.labels) {
          if (typeof name !== 'string') continue;
          const canonical = repo.labels.get(name.toLowerCase());
          if (canonical === undefined) return validation(`Validation Failed: label "${name}" does not exist`);
          labels.push(canonical);
        }
        issue.labels = labels;
      }
      return { status: 200, body: issueJson(store, repo, issue) };
    }
    return notFound();
  }
  if (rest[2] === 'comments' && rest.length === 3) {
    if (req.method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(store, comment)) };
    }
    if (req.method === 'POST') {
      const text = typeof req.body?.body === 'string' ? req.body.body : '';
      const comment = { id: store.nextComment(), body: text, createdSeq: store.nextSeq() };
      issue.comments.push(comment);
      return { status: 201, body: commentJson(store, comment) };
    }
  }
  return notFound();
}

function handlePulls(store: Store, repo: RepoRec, req: RestRequest, rest: readonly string[]): RestResult {
  if (rest.length === 1) {
    if (req.method === 'POST') {
      const body = req.body ?? {};
      if (typeof body.title !== 'string' || typeof body.head !== 'string') return validation('Validation Failed: title and head are required');
      try {
        const pull = createPullRecord(store, repo, {
          title: body.title,
          body: typeof body.body === 'string' ? body.body : '',
          head: body.head,
          base: typeof body.base === 'string' ? body.base : undefined,
        });
        return { status: 201, body: pullJson(store, repo, pull) };
      } catch (err) {
        if (err instanceof DomainError) return { status: err.status, body: { message: err.message } };
        throw err;
      }
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const ascending = req.query.get('direction') === 'asc';
      const all = [...repo.issues.values()]
        .filter((issue) => issue.isPull)
        .filter((issue) => state === 'all' || (state === 'closed' ? issue.state === 'closed' : issue.state === 'open'))
        .sort((a, b) => (ascending ? a.number - b.number : b.number - a.number))
        .map((pull) => pullJson(store, repo, pull));
      const page = paginate(all, req.query, req.host, req.path);
      return { status: 200, body: page.items, headers: page.headers };
    }
    return notFound();
  }
  const number = Number(rest[1]);
  const pull = Number.isSafeInteger(number) ? repo.issues.get(number) : undefined;
  if (pull === undefined || !pull.isPull) return notFound();
  if (rest.length === 2) {
    if (req.method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
    return notFound();
  }
  if (rest.length === 3 && rest[2] === 'files' && req.method === 'GET') {
    return { status: 200, body: pullFiles(repo, pull) };
  }
  if (rest.length === 3 && rest[2] === 'merge' && req.method === 'PUT') {
    const method = typeof req.body?.merge_method === 'string' ? req.body.merge_method : 'squash';
    if (method !== 'squash' && method !== 'merge') return { status: 405, body: { message: `Merge method ${method} is not available` } };
    const outcome = mergePullRecord(store, repo, pull, method);
    if (!outcome.ok) {
      return { status: 405, body: { message: outcome.reason === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request has already been merged or is closed' } };
    }
    return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

/** The changed-file list of a pull request: merge-base tree against head tree, with line counts. */
export function pullFiles(repo: RepoRec, pull: IssueRec): Record<string, unknown>[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(repo, headTip, baseTip);
  const baseFiles = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, (getCommit(repo, base) as { tree: string }).tree);
  const headFiles = flattenTree(repo, (getCommit(repo, headTip) as { tree: string }).tree);
  const files: Record<string, unknown>[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    const beforeText = before === undefined ? '' : (repo.objects.get(before.oid)?.data.toString('utf8') ?? '');
    const afterText = after === undefined ? '' : (repo.objects.get(after.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(beforeText, afterText);
    files.push({
      sha: after?.oid ?? before?.oid ?? ZERO_OID,
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

/** Additions/deletions between two texts by longest-common-subsequence over lines. */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    let prev = 0;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const saved = dp[j] as number;
      dp[j] = a[i] === b[j] ? prev + 1 : Math.max(dp[j] as number, dp[j + 1] as number);
      prev = saved;
    }
  }
  const common = dp[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

// ---------------------------------------------------------------- contents

function resolveRef(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function handleContents(store: Store, repo: RepoRec, req: RestRequest, rest: readonly string[]): RestResult {
  void store;
  const path = rest.slice(1).join('/');
  if (req.method === 'GET') {
    const tip = resolveRef(repo, req.query.get('ref'));
    if (tip === null) return notFound();
    const commitOid = peelToCommit(repo, tip);
    const commit = commitOid === null ? null : getCommit(repo, commitOid);
    if (commit === null) return notFound();
    if (path === '') return { status: 200, body: dirListing(repo, commit.tree, '') };
    const segments = path.split('/');
    const found = treePath(repo, commit.tree, segments);
    if (found === null) return notFound();
    const object = repo.objects.get(found.oid);
    if (object === undefined) return notFound();
    if (object.type === 'tree') return { status: 200, body: dirListing(repo, found.oid, path) };
    return {
      status: 200,
      body: {
        name: segments[segments.length - 1],
        path,
        sha: found.oid,
        size: object.data.length,
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
      },
    };
  }
  if (req.method === 'PUT') {
    const body = req.body ?? {};
    if (path === '' || typeof body.content !== 'string') return validation('Validation Failed: content is required');
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const parent = repo.refs.get(`refs/heads/${branch}`) ?? null;
    const segments = path.split('/');
    const parentCommit = parent === null ? null : getCommit(repo, parent);
    const existing = parentCommit === null ? null : treePath(repo, parentCommit.tree, segments);
    const givenSha = typeof body.sha === 'string' ? body.sha : null;
    if (existing !== null && givenSha !== existing.oid) {
      return { status: 409, body: { message: `${path} does not match ${givenSha ?? ''}` } };
    }
    if (existing === null && givenSha !== null) return validation('Validation Failed: sha supplied for a new file');
    const data = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
    const blobOid = hashObject('blob', data);
    repo.objects.set(blobOid, { type: 'blob', data });
    const tree = setFileInTree(repo, parentCommit?.tree ?? null, segments, blobOid);
    const commitOid = forgeCommit(repo, tree, parent, typeof body.message === 'string' ? body.message : `Update ${path}`);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return {
      status: existing !== null ? 200 : 201,
      body: {
        content: { name: segments[segments.length - 1], path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitOid, message: typeof body.message === 'string' ? body.message : '' },
      },
    };
  }
  if (req.method === 'DELETE') {
    const body = req.body ?? {};
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const parent = repo.refs.get(`refs/heads/${branch}`) ?? null;
    if (parent === null) return notFound();
    const parentCommit = getCommit(repo, parent);
    if (parentCommit === null) return notFound();
    const segments = path.split('/');
    const existing = treePath(repo, parentCommit.tree, segments);
    if (existing === null) return notFound();
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      return { status: 409, body: { message: `${path} does not match ${body.sha}` } };
    }
    const tree = setFileInTree(repo, parentCommit.tree, segments, null);
    const commitOid = forgeCommit(repo, tree, parent, typeof body.message === 'string' ? body.message : `Delete ${path}`);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { status: 200, body: { content: null, commit: { sha: commitOid } } };
  }
  return notFound();
}

function dirListing(repo: RepoRec, treeOid: string, prefix: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const child = repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: isDir || child === undefined ? 0 : child.data.length,
      type: isDir ? 'dir' : 'file',
    };
  });
}

// ---------------------------------------------------------------- git refs and branches

function handleGitRefs(store: Store, repo: RepoRec, req: RestRequest, rest: readonly string[]): RestResult {
  void store;
  // rest = ['git', 'refs', ...]
  if (rest.length === 2 && req.method === 'POST') {
    const ref = typeof req.body?.ref === 'string' ? req.body.ref : '';
    const sha = typeof req.body?.sha === 'string' ? req.body.sha : '';
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return validation('Validation Failed: ref or sha is invalid');
    repo.refs.set(ref, sha);
    const object = repo.objects.get(sha) as { type: string };
    return { status: 201, body: { ref, node_id: `REF_${ref}`, object: { sha, type: object.type } } };
  }
  if (rest.length >= 4 && rest[2] === 'heads' && req.method === 'GET') {
    const branch = rest.slice(3).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return notFound();
    return { status: 200, body: { ref: `refs/heads/${branch}`, node_id: `REF_heads_${branch}`, object: { sha, type: 'commit' } } };
  }
  if (rest.length === 2 && req.method === 'GET') {
    return {
      status: 200,
      body: [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } })),
    };
  }
  return notFound();
}

function handleBranches(store: Store, repo: RepoRec, req: RestRequest, rest: readonly string[]): RestResult {
  void store;
  if (rest.length === 1 && req.method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, body: branches };
  }
  if (rest.length >= 2 && req.method === 'GET') {
    const branch = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return notFound();
    return { status: 200, body: { name: branch, commit: { sha, url: '' }, protected: false } };
  }
  return notFound();
}

function handleCommits(store: Store, repo: RepoRec, req: RestRequest, rest: readonly string[]): RestResult {
  void store;
  if (rest.length !== 1 || req.method !== 'GET') return notFound();
  const shaParam = req.query.get('sha');
  const tip = resolveRef(repo, shaParam);
  if (tip === null) return { status: 409, body: { message: 'Git Repository is empty.' } };
  const start = peelToCommit(repo, tip);
  if (start === null) return { status: 409, body: { message: 'Git Repository is empty.' } };
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier = [start];
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
  const body = order.map((oid) => {
    const commit = getCommit(repo, oid) as NonNullable<ReturnType<typeof getCommit>>;
    const ident = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      return {
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: isoOf(Number(match?.[3] ?? '0')),
      };
    };
    return {
      sha: oid,
      commit: {
        message: commit.message,
        tree: { sha: commit.tree },
        author: ident(commit.author),
        committer: ident(commit.committer),
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  const page = paginate(body, req.query, req.host, req.path);
  return { status: 200, body: page.items, headers: page.headers };
}
