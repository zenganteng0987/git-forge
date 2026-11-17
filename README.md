[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zenganteng0987/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/zenganteng0987/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# A GitHub-compatible git forge

An entry for [github-core-clone-01](https://make.fun/bounty/github-core-clone-01): a self-contained
GitHub-compatible forge in TypeScript on Node's standard library only — no dependencies, no `git`
binary, no network calls. One in-memory store sits behind four surfaces, so an object or issue
created through any one of them is visible through all the others:

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests (files, squash/merge), pagination |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository fields, issue/pull connections with cursor pagination, search, node, introspection, and the create/close/merge mutations |
| `POST /mcp` | Model Context Protocol (JSON-RPC 2.0): `server/discover`, `tools/list`, `tools/call` for create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |
| `/{owner}/{repo}.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 ls-refs and fetch, v0 fetch), `git-receive-pack` (v0, report-status) |

## How it works

- **Git objects** (`gitobj.ts`) — SHA-1 object ids, commit/tree/tag parsing and building, packfile
  reading (including ofs/ref delta resolution) and writing (full objects, no deltas), and the
  pkt-line codec.
- **Store** (`store.ts`) — per-repository object stores and refs, the shared issue/pull-request
  numbering sequence, and the graph walks (closure, depth windows, merge-base, three-way tree
  merge). Timestamps derive from a per-repo logical clock, so behaviour is deterministic.
- **Protocol** (`gitproto.ts`) — ref advertisement (v0 and v2), ls-refs with ref-prefix
  filtering, fetch with shallow/deepen/deepen-since/deepen-not negotiation and `blob:none` /
  `blob:limit` filters, and receive-pack with fast-forward enforcement and per-ref report-status.
- **REST** (`rest.ts`) — the v3 resources and serializers, plus the domain operations the other
  surfaces share (issue/pull creation, pull-request file diffs by LCS line counts, merges).
- **GraphQL** (`graphql.ts`) — a hand-written lexer/parser/executor for the API's document shapes,
  with opaque, stable base64 global ids (never the plain database id).
- **MCP** (`mcp.ts`) — the modern discovery era (no session handshake), a static tools list, and
  tools that wrap the same store as REST.
- **Server** (`app.ts`) — routing and bearer-token auth (`MAKEFUN_SHOP_TOKEN`) for every surface
  but the health probe; unknown owners and routes answer GitHub-shaped 404s.

Pull-request merges are file-level three-way merges against the merge-base: a path both sides
changed differently is a conflict (405 / `CONFLICTING`), everything else lands as one squash
commit on the base branch.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that
   is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
   The first register wins; a later one is answered `409`.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until it answers `{"done":true}`.
4. **Exit 0** when it does.

`main.ts` also hands the process's `MAKEFUN_SHOP_TOKEN` to the app explicitly, so the server never
has to reach back into the environment itself.

## Layout

- `main.ts` — the entry <-> env lifecycle.
- `app.ts` — HTTP routing and auth.
- `gitobj.ts`, `gitproto.ts` — the git object model, packfiles, and the smart-HTTP protocol.
- `store.ts` — in-memory state and graph algorithms.
- `rest.ts`, `graphql.ts`, `mcp.ts` — the three API surfaces.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).
