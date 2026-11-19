// src/rest.ts — GitHub REST v3 under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id.
// Errors carry a JSON body with a string `message`. Unknown routes are a
// JSON 404; a malformed JSON body is a 400. All routes except GET /api/v3/
// require `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` (401 without it).
// A repository name under any owner other than the token's login is a 404,
// never a 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized, viewer } from './auth.ts';
import {
  applyCommit,
  branchTip,
  forge,
  getObject,
  issueJson,
  labelJson,
  listCommits,
  listDirAtRef,
  listFilesAtRef,
  normalizeBranch,
  nowIso,
  pullFiles,
  pullJson,
  pullMergeable,
  readBlobAtRef,
  repoJson,
  commentJson,
  resolveRef,
  squashMerge,
  userJson,
} from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';
import {
  asBoolean,
  asString,
  isRecord,
  originOf,
  parseJsonBody,
  pathOf,
  queryInt,
  queryOf,
  readBody,
  sendError,
  sendJson,
  splitPath,
  nextRequestId,
} from './http.ts';

const METHODS_WITH_BODY = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** A paginated slice plus its Link header value ('' when a single page). */
function paginate<T>(items: readonly T[], query: URLSearchParams, req: IncomingMessage, path: string): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, queryInt(query, 'per_page', 30)));
  const pageNum = Math.max(1, queryInt(query, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link = '';
  if (totalPages > 1) {
    const base = `${originOf(req)}${path}`;
    const other = new URLSearchParams();
    for (const [key, value] of query) if (key !== 'page') other.set(key, value);
    other.set('per_page', String(perPage));
    const parts: string[] = [];
    if (pageNum < totalPages) {
      const next = new URLSearchParams(other);
      next.set('page', String(pageNum + 1));
      parts.push(`<${base}?${next.toString()}>; rel="next"`);
    }
    if (pageNum > 1) {
      const prev = new URLSearchParams(other);
      prev.set('page', String(pageNum - 1));
      parts.push(`<${base}?${prev.toString()}>; rel="prev"`);
    }
    const last = new URLSearchParams(other);
    last.set('page', String(totalPages));
    parts.push(`<${base}?${last.toString()}>; rel="last"`);
    const first = new URLSearchParams(other);
    first.set('page', '1');
    parts.push(`<${base}?${first.toString()}>; rel="first"`);
    link = parts.join(', ');
  }
  return { page, link };
}

function sendPage<T>(res: ServerResponse, items: readonly T[], query: URLSearchParams, req: IncomingMessage, path: string): void {
  const { page, link } = paginate(items, query, req, path);
  sendJson(res, 200, page, link === '' ? {} : { link });
}

/** Load a repository for an /api/v3/repos/{owner}/{repo} route, or answer 404. */
function loadRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== viewer().login) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function sortIssues(issues: Issue[], sort: string, direction: string): Issue[] {
  const dir = direction === 'asc' ? 1 : -1;
  const sorted = [...issues];
  if (sort === 'updated') sorted.sort((a, b) => (a.seq - b.seq) * dir);
  else sorted.sort((a, b) => (a.seq - b.seq) * dir); // 'created' (and default): creation order
  return sorted;
}

/** Handle one /api/v3 request. Returns true when the path was under /api/v3. */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const base = originOf(req);

  // The API root: 200 JSON with the token's scopes (no auth, as the starter).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  // Read and parse a JSON body when the method may carry one.
  let body: unknown = {};
  if (METHODS_WITH_BODY.has(method)) {
    const raw = await readBody(req);
    if (raw === null) {
      sendError(res, 400, 'Request body too large');
      return true;
    }
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      if (parsed.empty) body = {};
      else {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
    } else {
      body = parsed.value;
    }
  }
  const bodyObj: Record<string, unknown> = isRecord(body) ? body : {};

  const segments = splitPath(path); // ['api','v3',...]
  const rest = segments.slice(2);

  // GET /api/v3/meta
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }

  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    const v = viewer();
    sendJson(res, 200, {
      ...userJson(v),
      name: 'ada iversen',
      email: 'adaiversen@example.invalid',
      html_url: `${base}/${v.login}`,
      url: `${base}/api/v3/users/${v.login}`,
      avatar_url: '',
      public_repos: forge.listRepos().length,
      followers: 0,
      following: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    return true;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      sendPage(res, forge.listRepos().map((repo) => repoJson(repo, base)), query, req, path);
      return true;
    }
    if (method === 'POST') {
      const name = asString(bodyObj.name);
      if (name === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      const repo = forge.createRepo(name, { description: asString(bodyObj.description), private: asBoolean(bodyObj.private, false) });
      if (repo === null) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      sendJson(res, 201, repoJson(repo, base));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (tail.length === 0) {
      if (method === 'GET') {
        const repo = loadRepo(res, owner, name);
        if (repo === null) return true;
        sendJson(res, 200, repoJson(repo, base));
        return true;
      }
      if (method === 'PATCH') {
        const repo = loadRepo(res, owner, name);
        if (repo === null) return true;
        if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
        if (typeof bodyObj.private === 'boolean') repo.private = bodyObj.private;
        if (typeof bodyObj.has_issues === 'boolean') repo.has_issues = bodyObj.has_issues;
        repo.updated_at = nowIso();
        sendJson(res, 200, repoJson(repo, base));
        return true;
      }
      if (method === 'DELETE') {
        const repo = loadRepo(res, owner, name);
        if (repo === null) return true;
        forge.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return true;
      }
    }

    const repo = loadRepo(res, owner, name);
    if (repo === null) return true;

    // GET /repos/{o}/{r}/branches and /branches/{branch}
    if (tail.length >= 1 && tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const branches = [...repo.git.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.git.refs.get(`refs/heads/${branch}`) ?? '' }, protected: false }));
        sendJson(res, 200, branches);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const branch = tail[1] as string;
        const sha = branchTip(repo.git, branch);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return true;
      }
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const ref = query.get('sha') ?? repo.default_branch;
      const perPage = Math.min(100, Math.max(1, queryInt(query, 'per_page', 30)));
      const commits = listCommits(repo, ref, perPage).map((commit) => ({
        sha: commit.sha,
        commit: {
          message: commit.message,
          author: { name: 'adaiversen', email: 'adaiversen@example.invalid', date: nowIso() },
          committer: { name: 'adaiversen', email: 'adaiversen@example.invalid', date: nowIso() },
        },
        parents: commit.parents.map((sha) => ({ sha })),
        url: `${base}/api/v3/repos/${repo.full_name}/commits/${commit.sha}`,
        html_url: `${base}/${repo.full_name}/commit/${commit.sha}`,
      }));
      sendJson(res, 200, commits);
      return true;
    }

    // POST /repos/{o}/{r}/git/refs — create a branch.
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const ref = asString(bodyObj.ref);
      const sha = asString(bodyObj.sha).toLowerCase();
      if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha) || getObject(repo.git, sha) === undefined) {
        sendError(res, 422, 'Invalid ref or sha');
        return true;
      }
      repo.git.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `${base}/api/v3/repos/${repo.full_name}/git/refs/${ref}` });
      return true;
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (tail.length >= 3 && tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
      const refPath = tail.slice(2).join('/');
      const ref = `refs/${refPath}`;
      const sha = repo.git.refs.get(ref);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref, object: { sha, type: 'commit' }, url: `${base}/api/v3/repos/${repo.full_name}/git/refs/${ref}` });
      return true;
    }

    // Contents: /repos/{o}/{r}/contents/{path...}
    if (tail.length >= 1 && tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      const ref = query.get('ref') ?? repo.default_branch;
      if (method === 'GET') {
        const files = listFilesAtRef(repo, ref);
        const isDir = filePath === '' || [...files.keys()].some((p) => p.startsWith(`${filePath}/`));
        if (isDir) {
          const entries = listDirAtRef(repo, ref, filePath).map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
            sha: entry.sha,
            size: entry.type === 'file' ? (getObject(repo.git, entry.sha)?.data.length ?? 0) : 0,
            url: `${base}/api/v3/repos/${repo.full_name}/contents/${entry.path}`,
            html_url: `${base}/${repo.full_name}/blob/${ref}/${entry.path}`,
          }));
          sendJson(res, 200, entries);
          return true;
        }
        const blob = readBlobAtRef(repo, ref, filePath);
        if (blob === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: blob.sha,
          size: blob.data.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          url: `${base}/api/v3/repos/${repo.full_name}/contents/${filePath}`,
          html_url: `${base}/${repo.full_name}/blob/${ref}/${filePath}`,
        });
        return true;
      }
      if (method === 'PUT') {
        const branch = asString(bodyObj.branch, repo.default_branch);
        const message = asString(bodyObj.message, `Update ${filePath}`);
        const contentB64 = asString(bodyObj.content);
        if (contentB64 === '') {
          sendError(res, 422, 'content is required');
          return true;
        }
        const content = Buffer.from(contentB64, 'base64');
        const current = readBlobAtRef(repo, branch, filePath);
        const givenSha = asString(bodyObj.sha);
        if (current !== undefined) {
          if (givenSha === '') {
            sendError(res, 422, 'sha is required to update a file');
            return true;
          }
          if (givenSha.toLowerCase() !== current.sha) {
            sendError(res, 409, 'sha does not match the current file');
            return true;
          }
        } else if (givenSha !== '') {
          sendError(res, 422, 'file does not exist');
          return true;
        }
        const changes = new Map<string, Buffer | null>([[filePath, content]]);
        const result = applyCommit(repo, branch, changes, message);
        const blobSha = result.blobShas.get(filePath) ?? '';
        sendJson(res, current === undefined ? 201 : 200, {
          content: {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: blobSha,
            size: content.length,
            type: 'file',
            encoding: 'base64',
            url: `${base}/api/v3/repos/${repo.full_name}/contents/${filePath}`,
          },
          commit: { sha: result.commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const current = readBlobAtRef(repo, repo.default_branch, filePath);
        if (current === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const givenSha = asString(bodyObj.sha);
        if (givenSha !== '' && givenSha.toLowerCase() !== current.sha) {
          sendError(res, 409, 'sha does not match the current file');
          return true;
        }
        const message = asString(bodyObj.message, `Delete ${filePath}`);
        const result = applyCommit(repo, repo.default_branch, new Map([[filePath, null]]), message);
        sendJson(res, 200, { content: null, commit: { sha: result.commitSha, message } });
        return true;
      }
    }

    // Labels: POST/GET /repos/{o}/{r}/labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'POST') {
        const name = asString(bodyObj.name);
        if (name === '') {
          sendError(res, 422, 'name is required');
          return true;
        }
        const label = forge.createLabel(repo, name, asString(bodyObj.color, 'ededed'), asString(bodyObj.description));
        sendJson(res, 201, labelJson(label));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, repo.labels.map(labelJson));
        return true;
      }
    }

    // Issues
    if (tail.length >= 1 && tail[0] === 'issues') {
      // POST /issues, GET /issues
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = asString(bodyObj.title);
          if (title === '') {
            sendError(res, 422, 'title is required');
            return true;
          }
          const wanted = Array.isArray(bodyObj.labels) ? bodyObj.labels : [];
          const labels: NonNullable<Issue['labels']> = [];
          for (const entry of wanted) {
            const labelName = typeof entry === 'string' ? entry : isRecord(entry) ? asString(entry.name) : '';
            const found = repo.labels.find((label) => label.name === labelName);
            if (found === undefined) {
              sendError(res, 422, `Label does not exist: ${labelName}`);
              return true;
            }
            labels.push(found);
          }
          const issue = forge.createIssue(repo, title, asString(bodyObj.body), labels);
          sendJson(res, 201, issueJson(repo, issue, base));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = repo.issues;
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const sorted = sortIssues(issues, sort, direction);
          sendPage(res, sorted.map((issue) => issueJson(repo, issue, base)), query, req, path);
          return true;
        }
      }
      // /issues/{number} and /issues/{number}/comments
      const number = Number.parseInt(tail[1] ?? '', 10);
      if (tail.length >= 2 && Number.isInteger(number)) {
        const issue = forge.findIssue(repo, number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (tail.length === 2) {
          if (method === 'GET') {
            sendJson(res, 200, issueJson(repo, issue, base));
            return true;
          }
          if (method === 'PATCH') {
            if (typeof bodyObj.state === 'string' && (bodyObj.state === 'open' || bodyObj.state === 'closed')) issue.state = bodyObj.state;
            if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
            if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
            issue.updated_at = nowIso();
            sendJson(res, 200, issueJson(repo, issue, base));
            return true;
          }
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'POST') {
            const comment = forge.createComment(repo, issue, asString(bodyObj.body));
            sendJson(res, 201, commentJson(repo, issue, comment, base));
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment, base)));
            return true;
          }
        }
      }
    }

    // Pull requests
    if (tail.length >= 1 && tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = asString(bodyObj.title);
          const headRef = normalizeBranch(asString(bodyObj.head));
          const baseRef = normalizeBranch(asString(bodyObj.base, repo.default_branch));
          if (title === '' || headRef === '' || baseRef === '') {
            sendError(res, 422, 'title, head and base are required');
            return true;
          }
          if (branchTip(repo.git, headRef) === undefined) {
            sendError(res, 422, `head branch does not exist: ${headRef}`);
            return true;
          }
          if (branchTip(repo.git, baseRef) === undefined) {
            sendError(res, 422, `base branch does not exist: ${baseRef}`);
            return true;
          }
          const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head.ref === headRef && pull.base.ref === baseRef);
          if (duplicate !== undefined) {
            sendError(res, 422, 'A pull request already exists for this head branch');
            return true;
          }
          const pull = forge.createPull(repo, title, asString(bodyObj.body), headRef, baseRef);
          sendJson(res, 201, pullJson(repo, pull, base));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = repo.pulls;
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          const sorted = [...pulls].sort((a, b) => b.seq - a.seq);
          sendPage(res, sorted.map((pull) => pullJson(repo, pull, base)), query, req, path);
          return true;
        }
      }
      const number = Number.parseInt(tail[1] ?? '', 10);
      if (tail.length >= 2 && Number.isInteger(number)) {
        const pull = forge.findPull(repo, number);
        if (tail.length === 2) {
          if (method === 'GET') {
            if (pull === undefined) {
              sendError(res, 404, 'Not Found');
              return true;
            }
            sendJson(res, 200, pullJson(repo, pull, base));
            return true;
          }
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          if (pull === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          const files = pullFiles(repo, pull).map((change) => ({
            filename: change.path,
            status: change.status === 'modified' ? 'modified' : change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.additions + change.deletions,
            sha: change.newSha ?? change.oldSha ?? '',
            patch: '',
          }));
          sendJson(res, 200, files);
          return true;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          if (pull === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          if (pull.state !== 'open') {
            sendError(res, 405, 'Pull request is already closed');
            return true;
          }
          if (!pullMergeable(repo, pull)) {
            sendError(res, 405, 'Merge conflict');
            return true;
          }
          const merged = squashMerge(repo, pull);
          if (!merged.ok) {
            sendError(res, 405, merged.reason);
            return true;
          }
          sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
          return true;
        }
      }
    }
  }

  // Anything else under /api/v3: JSON 404.
  sendError(res, 404, 'Not Found');
  return true;
}
