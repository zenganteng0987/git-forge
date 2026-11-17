// The forge's HTTP server: one in-memory store behind four surfaces — git smart HTTP
// (/{owner}/{repo}.git/...), REST v3 (/api/v3), GraphQL v4 (/api/graphql) and MCP (/mcp).
// Every surface but the health probe requires the bearer token the harness issued this process
// (MAKEFUN_SHOP_TOKEN); a missing or wrong token is a 401, and every API answer is JSON with a
// request id, as GitHub's are.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { advertise, cachedResponse, handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack, repoFingerprint } from './gitproto.ts';
import { handleRest, type RestResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface AppOptions {
  /** The bearer token API callers must present; defaults to the MAKEFUN_SHOP_TOKEN env var. */
  readonly shopToken?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(options: AppOptions = {}): Server {
  const store = new Store();
  const token = options.shopToken ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const authed = (req: IncomingMessage): boolean =>
    token === '' || req.headers.authorization === `Bearer ${token}`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
    if (needsBody) {
      readBody(req).then(
        (body) => dispatch(store, token, authed, req, res, body, () => (requestCounter += 1)),
        () => {
          if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
        },
      );
    } else {
      dispatch(store, token, authed, req, res, Buffer.alloc(0), () => (requestCounter += 1));
    }
  });
  // Request/response ping-pong on keep-alive sockets should not wait on Nagle.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}

function dispatch(
  store: Store,
  token: string,
  authed: (req: IncomingMessage) => boolean,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  nextRequestId: () => number,
): void {
  void token;
  const requestId = nextRequestId().toString(16).padStart(4, '0').toUpperCase();
  const apiHeaders = { 'x-github-request-id': requestId };
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // The env's boot check: 200 {"ok":true}, no token.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- MCP
    if (path === '/mcp') {
      if (!authed(req)) {
        sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const result = handleMcp(store, body);
      if (result.body === null) {
        res.writeHead(result.status, { 'content-length': 0 });
        res.end();
      } else {
        sendJson(res, result.status, result.body);
      }
      return;
    }

    // ---- GraphQL
    if (path === '/api/graphql') {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Unauthorized' }, apiHeaders);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, apiHeaders);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, apiHeaders);
        return;
      }
      const result = handleGraphQL(store, parsed);
      sendJson(res, result.status, result.body, apiHeaders);
      return;
    }

    // ---- REST v3
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Unauthorized' }, apiHeaders);
        return;
      }
      let jsonBody: Record<string, unknown> | null = null;
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as unknown;
          jsonBody = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
          if (jsonBody === null) throw new Error('not an object');
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, apiHeaders);
          return;
        }
      }
      const segments = path
        .slice('/api/v3'.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map(decodeSegment);
      const result: RestResult = handleRest(store, {
        method,
        segments,
        query: url.searchParams,
        body: jsonBody,
        host: req.headers.host ?? 'localhost',
        path,
      });
      sendJson(res, result.status, result.body, { ...apiHeaders, ...(result.headers ?? {}) });
      return;
    }

    // ---- git smart HTTP
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch !== null) {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
      const owner = decodeSegment(gitMatch[1] as string);
      const name = decodeSegment(gitMatch[2] as string);
      const repo = store.repo(owner, name);
      if (repo === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const route = gitMatch[3] as string;
      if (route === 'info/refs' && method === 'GET') {
        const service = url.searchParams.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'Missing or unknown service' });
          return;
        }
        const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        // Advertisements and upload-pack answers are pure functions of repo state + request;
        // the fingerprint in the key moves on any mutation, so a cached body is always the
        // body a fresh computation would produce for the state it is served in.
        const fingerprint = repoFingerprint(repo);
        const advertised = cachedResponse(repo, `${fingerprint}|refs|${service}|${version2 ? 2 : 0}`, () => advertise(repo, service, version2).body);
        sendBuffer(res, 200, advertised, `application/x-${service}-advertisement`);
        return;
      }
      if (route === 'git-upload-pack' && method === 'POST') {
        const key = `${repoFingerprint(repo)}|up|${body.length}|${createHash('sha1').update(body).digest('hex')}`;
        const answered = cachedResponse(repo, key, () => {
          const firstLine = firstPktPayload(body);
          if (firstLine.startsWith('command=ls-refs')) return handleLsRefs(repo, body);
          if (firstLine.startsWith('command=fetch')) return handleFetchV2(repo, body);
          return handleFetchV0(repo, body);
        });
        sendBuffer(res, 200, answered, 'application/x-git-upload-pack-result');
        return;
      }
      if (route === 'git-receive-pack' && method === 'POST') {
        sendBuffer(res, 200, handleReceivePack(repo, body), 'application/x-git-receive-pack-result');
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, path.startsWith('/api/') ? apiHeaders : {});
  } catch (err) {
    process.stderr.write(`[forge] request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    else res.end();
  }
}

/** The first pkt-line payload of a request body, as text ('' when it is not pkt-framed). */
function firstPktPayload(body: Buffer): string {
  if (body.length < 4) return '';
  const length = Number.parseInt(body.toString('latin1', 0, 4), 16);
  if (!Number.isFinite(length) || length < 4 || length > body.length) return '';
  return body.toString('utf8', 4, length);
}
