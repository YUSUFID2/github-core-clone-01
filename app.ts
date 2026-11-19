// app.ts — the server: createApp() routes every surface the forge serves.
//
//   GET  /healthz                  200 {"ok":true} (the env's boot probe)
//   /{owner}/{repo}.git/*          git smart HTTP (src/git, Builder A):
//                                  info/refs, git-upload-pack, git-receive-pack
//   /api/v3/*                      GitHub REST v3 (src/rest.ts)
//   POST /api/graphql              GitHub GraphQL v4 (src/graphql.ts)
//   POST /mcp                      Model Context Protocol (src/mcp.ts)
//   anything else                  404 {"message":"Not Found"} (JSON, never HTML)
//
// Every REST/GraphQL/MCP reply is application/json with a non-empty
// X-GitHub-Request-Id. Git replies use git's own content types.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleInfoRefs, handleUploadPack } from './src/git/upload-pack.ts';
import { handleReceivePack } from './src/git/receive-pack.ts';
import { forge } from './src/store.ts';
import { pathOf, queryOf, sendError, sendJson } from './src/http.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1] as string;
          const repoName = gitMatch[2] as string;
          const rest = gitMatch[3] ?? '';
          // A repository under another owner is not this token's: missing.
          const repo = owner === 'adaiversen' ? forge.getRepo(owner, repoName) : undefined;
          const store = repo === undefined ? undefined : repo.git;
          if (method === 'GET' && rest === '/info/refs') {
            const service = queryOf(req).get('service');
            if (service === 'git-upload-pack' || service === 'git-receive-pack') {
              await handleInfoRefs(store, service, req, res);
              return;
            }
            sendError(res, 404, 'Not Found');
            return;
          }
          if (method === 'POST' && rest === '/git-upload-pack') {
            await handleUploadPack(store, req, res);
            return;
          }
          if (method === 'POST' && rest === '/git-receive-pack') {
            await handleReceivePack(store, req, res);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          await handleGraphQL(req, res);
          return;
        }

        // Model Context Protocol.
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }

        // REST v3 (returns false when the path is not under /api/v3).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendError(res, 404, 'Not Found');
      } catch (err) {
        // A handler must never crash the server or answer HTML: JSON 500.
        try {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
