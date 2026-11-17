// The MCP endpoint at /mcp: JSON-RPC 2.0 over plain HTTP POSTs. The forge answers the modern
// discovery method (server/discover) with the protocol versions it speaks, so clients settle
// without a session handshake; the legacy initialize method is answered too. The six tools are
// thin wrappers over the same store the REST surface serves, so ids and numbers agree across
// surfaces. tools/list is a static array: byte-identical on every call.

import {
  DomainError,
  createIssueRecord,
  createPullRecord,
  issueJson,
  mergePullRecord,
  pullJson,
  repoJson,
} from './rest.ts';
import type { Store } from './store.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { type: string; description: string }>>;
    readonly required: readonly string[];
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user and return the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name.'),
        description: str('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('The repository owner login.'), repo: str('The repository name.') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository and return the issue object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed or all. Defaults to open.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        head: str('The head branch name.'),
        base: str('The base branch name.'),
        body: str('The pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge) and return the pull request object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpResult {
  readonly status: number;
  /** The JSON-RPC response value, or null for an empty (notification) answer. */
  readonly body: unknown;
}

const rpcError = (id: unknown, code: number, message: string): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

const rpcResult = (id: unknown, result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });

const toolOk = (payload: unknown): Record<string, unknown> => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  structuredContent: payload as Record<string, unknown>,
});

const toolError = (message: string): Record<string, unknown> => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Handle one JSON-RPC request object; returns null for notifications (no answer body). */
function handleOne(store: Store, request: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    return rpcResult(id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method.startsWith('notifications/')) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') return rpcResult(id, callTool(store, params));
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function callTool(store: Store, params: Record<string, unknown>): Record<string, unknown> {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    // Answered as a JSON-RPC error by the caller path below via a thrown marker.
    throw new ToolRpcError(-32602, `Unknown tool: ${name}`);
  }
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw new ToolRpcError(-32602, `Missing required argument: ${required}`);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  try {
    switch (name) {
      case 'create_repo': {
        const repoNameArg = String(args.name);
        const existing = store.repos.get(repoNameArg);
        if (existing !== undefined) return toolOk(repoJson(store, existing));
        const repo = store.createRepo(
          repoNameArg,
          typeof args.description === 'string' ? args.description : '',
          args.private === true,
        );
        return toolOk(repoJson(store, repo));
      }
      case 'get_repo': {
        const repo = store.repo(owner, repoName);
        if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
        return toolOk(repoJson(store, repo));
      }
      case 'create_issue': {
        const repo = store.repo(owner, repoName);
        if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
        const issue = createIssueRecord(store, repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolOk(issueJson(store, repo, issue));
      }
      case 'list_issues': {
        const repo = store.repo(owner, repoName);
        if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = [...repo.issues.values()]
          .filter((issue) => !issue.isPull)
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => b.number - a.number)
          .map((issue) => issueJson(store, repo, issue));
        return toolOk(issues);
      }
      case 'create_pull_request': {
        const repo = store.repo(owner, repoName);
        if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
        const pull = createPullRecord(store, repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: typeof args.base === 'string' ? args.base : undefined,
        });
        return toolOk(pullJson(store, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = store.repo(owner, repoName);
        if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
        const pull = repo.issues.get(Number(args.pull_number));
        if (pull === undefined || !pull.isPull) return toolError(`Pull request ${String(args.pull_number)} not found`);
        const outcome = mergePullRecord(store, repo, pull, 'squash');
        if (!outcome.ok) return toolError(outcome.reason === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request has already been merged or is closed');
        return toolOk(pullJson(store, repo, pull));
      }
      default:
        throw new ToolRpcError(-32602, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof DomainError) return toolError(err.message);
    throw err;
  }
}

class ToolRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** The /mcp endpoint: parse the body, dispatch, and shape the HTTP answer. */
export function handleMcp(store: Store, rawBody: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: the body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      try {
        const response = handleOne(store, item as Record<string, unknown>);
        if (response !== null) responses.push(response);
      } catch (err) {
        if (err instanceof ToolRpcError) responses.push(rpcError((item as Record<string, unknown>).id, err.code, err.message));
        else throw err;
      }
    }
    return { status: 200, body: responses };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = parsed as Record<string, unknown>;
  try {
    const response = handleOne(store, request);
    if (response === null) return { status: 202, body: null };
    return { status: 200, body: response };
  } catch (err) {
    if (err instanceof ToolRpcError) return { status: 200, body: rpcError(request.id, err.code, err.message) };
    throw err;
  }
}
