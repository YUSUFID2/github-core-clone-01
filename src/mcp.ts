// src/mcp.ts — Model Context Protocol at POST /mcp (JSON-RPC 2.0 over
// Streamable HTTP, revision 2026-07-28).
//
// server/discover answers the server identity, capabilities and
// supportedVersions (no handshake, no session). initialize is also answered
// for handshake-era clients. tools/list offers the github-mcp-server tools;
// tools/call executes them against the same store REST uses, so a repository
// or issue created over MCP reads back over /api/v3 as the same object.
//
// A call with no Authorization header is 401. A body that is not JSON is
// HTTP 400 with JSON-RPC -32700. An unknown tool is -32601; a tools/call
// missing a required argument is -32602 (never HTTP 500).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized } from './auth.ts';
import {
  branchTip,
  forge,
  issueJson,
  normalizeBranch,
  pullJson,
  pullMergeable,
  repoJson,
  squashMerge,
} from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';
import { isRecord, originOf, parseJsonBody, readBody, sendJson } from './http.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tools, in a fixed order with fixed key order: tools/list is byte-identical across calls. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The repository owner (the authenticated user).' },
        description: { type: 'string', description: 'A short description of the repository.' },
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
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

const TOOLS_BY_NAME = new Map<string, ToolDef>(TOOLS.map((tool) => [tool.name, tool]));

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function toolResult(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoOrError(owner: string, repoName: string): { repo: Repo } | { error: string } {
  if (owner !== 'adaiversen') return { error: `Repository not found: ${owner}/${repoName}` };
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return { error: `Repository not found: ${owner}/${repoName}` };
  return { repo };
}

/** Execute one tool; returns its result object (possibly isError:true). */
function callTool(name: string, args: Record<string, unknown>, base: string): Record<string, unknown> {
  const owner = asText(args.owner);
  const repoName = asText(args.repo);

  if (name === 'create_repo') {
    const repoNameArg = asText(args.name);
    if (repoNameArg === '') return toolError('create_repo: name is required');
    const repo = forge.createRepo(repoNameArg, {
      description: asText(args.description),
      private: asBool(args.private),
    });
    if (repo === null) return toolError(`create_repo: repository already exists: ${repoNameArg}`);
    return toolResult(repoJson(repo, base));
  }

  if (name === 'get_repo') {
    const found = repoOrError(owner, repoName);
    if ('error' in found) return toolError(found.error);
    return toolResult(repoJson(found.repo, base));
  }

  if (name === 'create_issue') {
    const found = repoOrError(owner, repoName);
    if ('error' in found) return toolError(found.error);
    const title = asText(args.title);
    if (title === '') return toolError('create_issue: title is required');
    const issue = forge.createIssue(found.repo, title, asText(args.body), []);
    return toolResult(issueJson(found.repo, issue, base));
  }

  if (name === 'list_issues') {
    const found = repoOrError(owner, repoName);
    if ('error' in found) return toolError(found.error);
    const state = asText(args.state, 'open');
    let issues: Issue[] = found.repo.issues;
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    return toolResult({ issues: issues.map((issue) => issueJson(found.repo, issue, base)) });
  }

  if (name === 'get_issue') {
    const found = repoOrError(owner, repoName);
    if ('error' in found) return toolError(found.error);
    const number = asInt(args.issue_number);
    const issue = number === null ? undefined : forge.findIssue(found.repo, number);
    if (issue === undefined) return toolError(`get_issue: issue not found: ${String(number)}`);
    return toolResult(issueJson(found.repo, issue, base));
  }

  if (name === 'create_pull_request') {
    const found = repoOrError(owner, repoName);
    if ('error' in found) return toolError(found.error);
    const repo = found.repo;
    const title = asText(args.title);
    const head = normalizeBranch(asText(args.head));
    const baseRef = normalizeBranch(asText(args.base, repo.default_branch));
    if (title === '') return toolError('create_pull_request: title is required');
    if (branchTip(repo.git, head) === undefined) return toolError(`create_pull_request: head branch does not exist: ${head}`);
    if (branchTip(repo.git, baseRef) === undefined) return toolError(`create_pull_request: base branch does not exist: ${baseRef}`);
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head.ref === head && pull.base.ref === baseRef);
    if (duplicate !== undefined) return toolError('create_pull_request: a pull request already exists for this head branch');
    const pull = forge.createPull(repo, title, asText(args.body), head, baseRef);
    return toolResult(pullJson(repo, pull, base));
  }

  if (name === 'merge_pull_request') {
    const found = repoOrError(owner, repoName);
    if ('error' in found) return toolError(found.error);
    const repo = found.repo;
    const number = asInt(args.pull_number);
    const pull = number === null ? undefined : forge.findPull(repo, number);
    if (pull === undefined) return toolError(`merge_pull_request: pull request not found: ${String(number)}`);
    if (pull.state !== 'open') return toolError('merge_pull_request: pull request is not open');
    if (!pullMergeable(repo, pull)) return toolError('merge_pull_request: merge conflict');
    const merged = squashMerge(repo, pull);
    if (!merged.ok) return toolError(`merge_pull_request: ${merged.reason}`);
    return toolResult(pullJson(repo, pull, base));
  }

  if (name === 'list_pull_requests') {
    const found = repoOrError(owner, repoName);
    if ('error' in found) return toolError(found.error);
    const state = asText(args.state, 'open');
    let pulls: PullRequest[] = found.repo.pulls;
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    return toolResult({ pull_requests: pulls.map((pull) => pullJson(found.repo, pull, base)) });
  }

  return toolError(`unknown tool: ${name}`);
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, httpStatus: number, id: unknown, code: number, message: string): void {
  sendJson(res, httpStatus, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** Handle one POST /mcp request. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!isAuthorized(req)) {
    rpcError(res, 401, null, -32001, 'Unauthorized');
    return;
  }
  const raw = await readBody(req);
  if (raw === null) {
    rpcError(res, 400, null, -32700, 'Parse error');
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok || !isRecord(parsed.value)) {
    rpcError(res, 400, null, -32700, 'Parse error');
    return;
  }
  const body = parsed.value;
  const id: unknown = 'id' in body ? body.id : undefined;
  const rpcMethod = typeof body.method === 'string' ? body.method : '';

  // A notification (no id) is answered with 202 and no body.
  if (id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }

  const params = isRecord(body.params) ? body.params : {};
  const base = originOf(req);

  if (rpcMethod === 'server/discover') {
    rpcResult(res, id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }

  if (rpcMethod === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
    rpcResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (rpcMethod === 'ping') {
    rpcResult(res, id, {});
    return;
  }

  if (rpcMethod === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return;
  }

  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS_BY_NAME.get(name);
    if (tool === undefined) {
      rpcError(res, 200, id, -32601, `Method not found: ${name}`);
      return;
    }
    const missing = tool.inputSchema.required.filter((prop) => !(prop in args) || args[prop] === undefined || args[prop] === null || args[prop] === '');
    if (missing.length > 0) {
      rpcError(res, 200, id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
      return;
    }
    let result: Record<string, unknown>;
    try {
      result = callTool(name, args, base);
    } catch (err) {
      result = toolError(err instanceof Error ? err.message : 'tool failed');
    }
    rpcResult(res, id, result);
    return;
  }

  rpcError(res, 200, id, -32601, `Method not found: ${rpcMethod}`);
}
