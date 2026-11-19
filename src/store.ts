// src/store.ts — the forge's in-memory store plus its git object layer.
//
// The store holds repositories, issues, pull requests, labels and comments in
// Maps. Every repository also holds a GitStore: real git objects (SHA-1 over
// "<type> <len>\0" + data) and refs, so file contents and commits are genuine
// git objects that the smart-HTTP layer (src/git, Builder A) reads from the
// same Maps. This module is deliberately self-contained: it defines the
// GitStore shape structurally (identical to src/git/store.ts's) and builds
// its objects itself, so REST/GraphQL/MCP work even before src/git lands.
//
// Determinism: no wall clock and no unseeded randomness anywhere here.
// Every timestamp comes from MAKEFUN_TRIAL_NOW (default
// '2026-11-14T06:30:00Z'), every id from a counter.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Time (trial time only)
// ---------------------------------------------------------------------------

const TRIAL_NOW_RAW = process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00Z';
const TRIAL_NOW_MS = Date.parse(TRIAL_NOW_RAW);
const TRIAL_NOW = Number.isFinite(TRIAL_NOW_MS) ? TRIAL_NOW_RAW : '2026-11-14T06:30:00Z';
const TRIAL_EPOCH = Number.isFinite(TRIAL_NOW_MS) ? Math.floor(TRIAL_NOW_MS / 1000) : 1794606600;

/** The trial's now, as an ISO string. */
export function nowIso(): string {
  return TRIAL_NOW;
}

/** The trial's now, as epoch seconds (for git author/committer lines). */
export function nowEpoch(): number {
  return TRIAL_EPOCH;
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface GitStore {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
}

export function createGitStore(): GitStore {
  return { objects: new Map<string, GitObject>(), refs: new Map<string, string>() };
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export function storeObject(store: GitStore, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  store.objects.set(sha, { type, data });
  return sha;
}

export function getObject(store: GitStore, sha: string): GitObject | undefined {
  return store.objects.get(sha.toLowerCase());
}

/** A parsed commit object. */
export interface ParsedCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(store: GitStore, sha: string): ParsedCommit | null {
  const obj = getObject(store, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  if (tree === '') return null;
  return { sha: sha.toLowerCase(), tree, parents, message };
}

/** One parsed tree entry: mode, name, child sha. */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(store: GitStore, sha: string): TreeEntry[] | null {
  const obj = getObject(store, sha);
  if (obj === undefined || obj.type !== 'tree') return null;
  const data = obj.data;
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) return null;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) return null;
    const mode = data.toString('utf8', i, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Flatten a tree into path -> blob sha (files only). */
export function flattenTree(store: GitStore, treeSha: string, prefix: string, out: Map<string, string>): void {
  const entries = parseTree(store, treeSha);
  if (entries === null) return;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, entry.sha);
  }
}

/** The flat file map of a commit's tree (path -> blob sha). */
export function filesAtCommit(store: GitStore, commitSha: string): Map<string, string> {
  const commit = parseCommit(store, commitSha);
  const out = new Map<string, string>();
  if (commit === null) return out;
  flattenTree(store, commit.tree, '', out);
  return out;
}

/** Build a tree object from a flat file map (path -> blob sha). */
export function buildTree(store: GitStore, files: Map<string, string>): string {
  // Group paths into a nested directory structure, then build bottom-up.
  interface Dir {
    files: Map<string, string>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = dir.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, child);
      }
      dir = child;
    }
    dir.files.set(parts[parts.length - 1] as string, sha);
  }
  const build = (dir: Dir): string => {
    const entries: { mode: string; name: string; sha: string }[] = [];
    for (const [name, sha] of dir.files) entries.push({ mode: '100644', name, sha });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    // Git tree order: entries sorted by name, directories as if named "name/".
    entries.sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      chunks.push(Buffer.from(entry.sha, 'hex'));
    }
    return storeObject(store, 'tree', Buffer.concat(chunks));
  };
  return build(root);
}

/** Build a commit object and store it; returns its sha. */
export function buildCommit(store: GitStore, treeSha: string, parents: string[], message: string): string {
  const ident = `adaiversen <adaiversen@example.invalid> ${TRIAL_EPOCH} +0000`;
  let text = `tree ${treeSha}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return storeObject(store, 'commit', Buffer.from(text, 'utf8'));
}

/** Resolve a branch name, full ref, or sha to a commit sha (or undefined). */
export function resolveRef(store: GitStore, ref: string): string | undefined {
  if (ref === '') return undefined;
  const direct = store.refs.get(ref);
  if (direct !== undefined) return direct;
  const headed = store.refs.get(`refs/heads/${ref}`);
  if (headed !== undefined) return headed;
  if (/^[0-9a-f]{40}$/i.test(ref) && getObject(store, ref) !== undefined) return ref.toLowerCase();
  return undefined;
}

/** The tip commit sha of a branch (undefined when the branch does not exist). */
export function branchTip(store: GitStore, branch: string): string | undefined {
  return store.refs.get(`refs/heads/${branch}`);
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Owner {
  login: string;
  id: number;
}

export const VIEWER: Owner = { login: 'adaiversen', id: 1000 };

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: Owner;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: Owner;
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
  /** Creation order (monotonic per repo); sort keys use this, not the clock. */
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: Owner;
  created_at: string;
  updated_at: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: Owner;
  description: string;
  default_branch: string;
  private: boolean;
  has_issues: boolean;
  created_at: string;
  updated_at: string;
  git: GitStore;
  labels: Label[];
  issues: Issue[];
  pulls: PullRequest[];
  /** Issues and pull requests share one counter per repository (GitHub behaviour). */
  nextNumber: number;
}

function stripRefPrefix(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function stripOwnerPrefix(ref: string): string {
  // "owner:branch" -> "branch" (gh sends plain branch names; accept both).
  const colon = ref.indexOf(':');
  if (colon !== -1 && !ref.startsWith('refs/')) return ref.slice(colon + 1);
  return ref;
}

export function normalizeBranch(ref: string): string {
  return stripOwnerPrefix(stripRefPrefix(ref));
}

// ---------------------------------------------------------------------------
// The forge store
// ---------------------------------------------------------------------------

export class ForgeStore {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextObjectId = 1;
  nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo | null {
    const key = this.key(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      full_name: `${VIEWER.login}/${name}`,
      owner: { ...VIEWER },
      description: options.description ?? '',
      default_branch: 'main',
      private: options.private ?? false,
      has_issues: true,
      created_at: nowIso(),
      updated_at: nowIso(),
      git: createGitStore(),
      labels: [],
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  createLabel(repo: Repo, name: string, color?: string, description?: string): Label {
    const existing = repo.labels.find((label) => label.name === name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color: color ?? 'ededed', description: description ?? '' };
    repo.labels.push(label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      user: { ...VIEWER },
      created_at: nowIso(),
      updated_at: nowIso(),
      comments: [],
      seq: this.nextSeq,
    };
    this.nextObjectId += 1;
    this.nextSeq += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = {
      id: this.nextObjectId,
      body,
      user: { ...VIEWER },
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.nextObjectId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    const headSha = branchTip(repo.git, headRef) ?? '';
    const baseSha = branchTip(repo.git, baseRef) ?? '';
    const pull: PullRequest = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      merge_commit_sha: null,
      merged_at: null,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      user: { ...VIEWER },
      created_at: nowIso(),
      updated_at: nowIso(),
      seq: this.nextSeq,
    };
    this.nextObjectId += 1;
    this.nextSeq += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }
}

/** The single shared store: REST, GraphQL and MCP all read and write it. */
export const forge = new ForgeStore();

// ---------------------------------------------------------------------------
// Contents / commits on top of a repository's git store
// ---------------------------------------------------------------------------

export interface CommitResult {
  commitSha: string;
  /** path -> blob sha for every changed path. */
  blobShas: Map<string, string>;
}

/**
 * Apply file changes on a branch and commit them. `changes` maps a path to
 * new bytes, or null to delete the path. Creates the branch from the default
 * branch tip when it does not exist yet (and the repository has one), or as
 * the root commit when the repository is still empty.
 */
export function applyCommit(repo: Repo, branch: string, changes: Map<string, Buffer | null>, message: string): CommitResult {
  const store = repo.git;
  let tip = branchTip(store, branch);
  if (tip === undefined && branch !== repo.default_branch) {
    const baseTip = branchTip(store, repo.default_branch);
    if (baseTip !== undefined) tip = baseTip;
  }
  const files = tip === undefined ? new Map<string, string>() : filesAtCommit(store, tip);
  const blobShas = new Map<string, string>();
  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
    } else {
      const blobSha = storeObject(store, 'blob', content);
      files.set(path, blobSha);
      blobShas.set(path, blobSha);
    }
  }
  const treeSha = buildTree(store, files);
  const commitSha = buildCommit(store, treeSha, tip === undefined ? [] : [tip], message);
  store.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobShas };
}

/** Read one file's blob at a ref (branch name, full ref or sha). */
export function readBlobAtRef(repo: Repo, ref: string, path: string): { sha: string; data: Buffer } | undefined {
  const tip = resolveRef(repo.git, ref);
  if (tip === undefined) return undefined;
  const files = filesAtCommit(repo.git, tip);
  const blobSha = files.get(path);
  if (blobSha === undefined) return undefined;
  const obj = getObject(repo.git, blobSha);
  if (obj === undefined || obj.type !== 'blob') return undefined;
  return { sha: blobSha, data: obj.data };
}

/** The flat file map at a ref (path -> blob sha). */
export function listFilesAtRef(repo: Repo, ref: string): Map<string, string> {
  const tip = resolveRef(repo.git, ref);
  if (tip === undefined) return new Map();
  return filesAtCommit(repo.git, tip);
}

/** List a directory at a ref: immediate children as {type, name, path, sha}. */
export function listDirAtRef(
  repo: Repo,
  ref: string,
  dir: string,
): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] {
  const files = listFilesAtRef(repo, ref);
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  const tip = resolveRef(repo.git, ref);
  const treeShas = new Map<string, string>();
  if (tip !== undefined) {
    // Walk the tree once to learn directory shas.
    const walk = (treeSha: string, base: string): void => {
      const entries = parseTree(repo.git, treeSha);
      if (entries === null) return;
      for (const entry of entries) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') {
          treeShas.set(path, entry.sha);
          walk(entry.sha, path);
        }
      }
    };
    const commit = parseCommit(repo.git, tip);
    if (commit !== null) walk(commit.tree, '');
  }
  for (const [path, sha] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { type: 'file', name: rest, path, sha });
    } else {
      const name = rest.slice(0, slash);
      const childPath = prefix + name;
      if (!children.has(name)) {
        children.set(name, { type: 'dir', name, path: childPath, sha: treeShas.get(childPath) ?? '' });
      }
    }
  }
  return [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Commits reachable from a ref, newest first (depth-first from the tip). */
export function listCommits(repo: Repo, ref: string, limit: number): ParsedCommit[] {
  const tip = resolveRef(repo.git, ref);
  if (tip === undefined) return [];
  const out: ParsedCommit[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = parseCommit(repo.git, sha);
    if (commit === null) continue;
    out.push(commit);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

/** The merge base of two commits: the first common ancestor found from `b`. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA: string[] = [a];
  while (stackA.length > 0) {
    const sha = stackA.pop() as string;
    if (ancestorsA.has(sha)) continue;
    ancestorsA.add(sha);
    const commit = parseCommit(repo.git, sha);
    if (commit !== null) for (const parent of commit.parents) stackA.push(parent);
  }
  const stackB: string[] = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const sha = stackB.pop() as string;
    if (seenB.has(sha)) continue;
    seenB.add(sha);
    if (ancestorsA.has(sha)) return sha;
    const commit = parseCommit(repo.git, sha);
    if (commit !== null) for (const parent of commit.parents) stackB.push(parent);
  }
  return null;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldSha?: string;
  newSha?: string;
  additions: number;
  deletions: number;
}

function countLines(data: Buffer | undefined): number {
  if (data === undefined || data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** Diff two flat file maps (path -> blob sha). */
export function diffFileMaps(repo: Repo, from: Map<string, string>, to: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of paths) {
    const oldSha = from.get(path);
    const newSha = to.get(path);
    if (oldSha === newSha) continue;
    const oldData = oldSha === undefined ? undefined : getObject(repo.git, oldSha)?.data;
    const newData = newSha === undefined ? undefined : getObject(repo.git, newSha)?.data;
    if (oldSha === undefined) {
      changes.push({ path, status: 'added', newSha, additions: countLines(newData), deletions: 0 });
    } else if (newSha === undefined) {
      changes.push({ path, status: 'deleted', oldSha, additions: 0, deletions: countLines(oldData) });
    } else {
      changes.push({ path, status: 'modified', oldSha, newSha, additions: countLines(newData), deletions: countLines(oldData) });
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** The changed files of a pull request: merge-base -> head tip. */
export function pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
  const headSha = branchTip(repo.git, pull.head.ref) ?? pull.head.sha;
  const baseSha = branchTip(repo.git, pull.base.ref) ?? pull.base.sha;
  if (headSha === '' || baseSha === '') return [];
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return [];
  return diffFileMaps(repo, filesAtCommit(repo.git, base), filesAtCommit(repo.git, headSha));
}

/** Whether a pull request can be squash-merged onto its base right now. */
export function pullMergeable(repo: Repo, pull: PullRequest): boolean {
  if (pull.state !== 'open') return false;
  const headSha = branchTip(repo.git, pull.head.ref);
  const baseSha = branchTip(repo.git, pull.base.ref);
  if (headSha === undefined || baseSha === undefined) return false;
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return false;
  const mbFiles = filesAtCommit(repo.git, base);
  const headFiles = filesAtCommit(repo.git, headSha);
  const baseFiles = filesAtCommit(repo.git, baseSha);
  for (const change of diffFileMaps(repo, mbFiles, headFiles)) {
    const mbVersion = mbFiles.get(change.path);
    const baseVersion = baseFiles.get(change.path);
    if (mbVersion !== baseVersion && change.newSha !== baseVersion) return false;
  }
  return true;
}

/** Squash-merge a pull request onto its base branch. */
export function squashMerge(repo: Repo, pull: PullRequest): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.state !== 'open') return { ok: false, reason: 'pull request is not open' };
  const headSha = branchTip(repo.git, pull.head.ref);
  const baseSha = branchTip(repo.git, pull.base.ref);
  if (headSha === undefined || baseSha === undefined) return { ok: false, reason: 'head or base branch is missing' };
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return { ok: false, reason: 'no merge base' };
  const mbFiles = filesAtCommit(repo.git, base);
  const headFiles = filesAtCommit(repo.git, headSha);
  const baseFiles = filesAtCommit(repo.git, baseSha);
  const merged = new Map<string, string>(baseFiles);
  for (const change of diffFileMaps(repo, mbFiles, headFiles)) {
    const mbVersion = mbFiles.get(change.path);
    const baseVersion = baseFiles.get(change.path);
    if (mbVersion !== baseVersion && change.newSha !== baseVersion) {
      return { ok: false, reason: 'merge conflict' };
    }
    if (change.newSha === undefined) merged.delete(change.path);
    else merged.set(change.path, change.newSha);
  }
  const treeSha = buildTree(repo.git, merged);
  const message = `Merge pull request #${pull.number} from ${repo.owner.login}/${pull.head.ref}\n\n${pull.title}`;
  const commitSha = buildCommit(repo.git, treeSha, [baseSha], message);
  repo.git.refs.set(`refs/heads/${pull.base.ref}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merge_commit_sha = commitSha;
  pull.merged_at = nowIso();
  pull.updated_at = nowIso();
  pull.head.sha = headSha;
  pull.base.sha = commitSha;
  return { ok: true, sha: commitSha };
}

// ---------------------------------------------------------------------------
// Serializers (REST shapes)
// ---------------------------------------------------------------------------

export function userJson(owner: Owner): Record<string, unknown> {
  return { login: owner.login, id: owner.id, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: repo.full_name,
    owner: userJson(repo.owner),
    description: repo.description,
    private: repo.private,
    fork: false,
    html_url: `${base}/${repo.full_name}`,
    url: `${base}/api/v3/repos/${repo.full_name}`,
    clone_url: `${base}/${repo.full_name}.git`,
    git_url: `${base}/${repo.full_name}.git`,
    ssh_url: `git@example.invalid:${repo.full_name}.git`,
    default_branch: repo.default_branch,
    has_issues: repo.has_issues,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    language: null,
    homepage: null,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: `${base}/${repo.full_name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.full_name}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: IssueComment, base: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('comment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `${base}/${repo.full_name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${base}/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `${base}/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest, base: string): Record<string, unknown> {
  const headSha = branchTip(repo.git, pull.head.ref) ?? pull.head.sha;
  const baseSha = branchTip(repo.git, pull.base.ref) ?? pull.base.sha;
  return {
    id: pull.id,
    node_id: globalId('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    head: { ref: pull.head.ref, sha: headSha, label: `${repo.owner.login}:${pull.head.ref}`, repo: repoJson(repo, base) },
    base: { ref: pull.base.ref, sha: baseSha, label: `${repo.owner.login}:${pull.base.ref}`, repo: repoJson(repo, base) },
    user: userJson(pull.user),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    draft: false,
    html_url: `${base}/${repo.full_name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.full_name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, never the plain database id.
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: number[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

/** Decode a global id into {kind, parts} or null. */
export function decodeGlobalId(id: string): { kind: string; parts: number[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const segments = text.split(':');
    const kind = segments[0];
    if (kind === undefined || kind === '') return null;
    const parts: number[] = [];
    for (const segment of segments.slice(1)) {
      const n = Number(segment);
      if (!Number.isInteger(n)) return null;
      parts.push(n);
    }
    return { kind, parts };
  } catch {
    return null;
  }
}
