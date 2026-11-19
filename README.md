# github-core-clone-01

[![github-core-clone-01](https://img.shields.io/badge/make.fun-github--core--clone--01-blue)](https://make.fun/bounty/github-core-clone-01)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A standalone, GitHub-compatible git forge — one Node process, standard
library only, no git binary, no network beyond the trial's suite. Built for
[the make.fun bounty](https://make.fun/bounty/github-core-clone-01)
([referral](https://make.fun/r/k62ycwh7)).

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `/{owner}/{repo}.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2), `git-receive-pack` (v0) |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP (revision 2026-07-28): `server/discover`, `tools/list`, `tools/call` |
| anything else | 404 `{"message":"Not Found"}` (JSON, never HTML) |

Everything is its own: repositories, issues, pull requests and file
contents live in an in-memory store, and file contents and commits are real
git objects (SHA-1 object store) shared by the git, REST, GraphQL and MCP
surfaces — a repository created over MCP reads back over REST as the same
object, with the same ids.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program
imports `node:http`, `node:crypto` and its own sources only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}`
   while the suite runs and `{"done":true}` once its export is written.
4. **Exit 0** when it does.

Auth: every API call presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
(the same token is in the entry's environment); the token names the viewer
`adaiversen` (id 1000), and a repository name under another owner is a 404,
never a 403. A request without the token is 401 (`/healthz` takes none).

## Layout

- `main.ts`: the lifecycle above (starter kit, verbatim).
- `app.ts`: the server wiring — health, git, REST, GraphQL, MCP.
- `src/store.ts`: the in-memory store and the git object layer (SHA-1
  objects, trees, commits, merge-base, squash merge).
- `src/rest.ts`: REST v3. `src/graphql.ts`: GraphQL v4 executor.
  `src/mcp.ts`: MCP JSON-RPC 2.0. `src/auth.ts`: bearer auth.
  `src/http.ts`: shared HTTP helpers.
- `src/git/`: git smart HTTP (upload-pack v2 / receive-pack v0) — see
  `app.ts` for the delegation point.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Rules and limits

Node 22 only, no dependencies at run time, no internet and no `git` binary
in the trial; the repository is mounted read-only at `/bot`. Timestamps come
from `MAKEFUN_TRIAL_NOW` only — no `Date.now()` or `Math.random()` in any
request path, so a live trial and its replay leave byte-identical state.

The score is `feature + agent + perf` (0..1000): the conformance checks over
that surface, the MCP checks again as the agent-native column, and four
timed workloads (push, clone, read, write).
