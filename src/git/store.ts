// In-memory git store: objects (SHA-1 -> {type, data}) and refs
// (full ref name -> SHA-1). This is the single source of truth Builder B's
// REST/GraphQL/MCP layers read and write; the smart-HTTP handlers in
// upload-pack.ts / receive-pack.ts only ever touch a GitStore through the
// functions here (plus getObject / refs lookups).
//
// No I/O, no clock, no randomness: every byte a commit carries comes from
// the caller's arguments, so two runs with the same arguments produce the
// same object ids.

import {
  buildCommit as buildCommitBytes,
  buildTree as buildTreeBytes,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTree,
  peelToCommit,
  ZERO_OID,
} from './objects.ts';
import type { GitObject, GitObjectType, TreeEntry } from './objects.ts';

export type { GitObject, GitObjectType, TreeEntry };

export interface GitStore {
  objects: Map<string, GitObject>; // sha1 hex -> object
  refs: Map<string, string>; // full ref name ('refs/heads/main') -> sha1 hex
}

export function createGitStore(): GitStore {
  return { objects: new Map(), refs: new Map() };
}

/** SHA-1 id + object for bytes that are not yet stored. */
export function sha1Object(type: GitObjectType, data: Buffer): { sha: string; object: GitObject } {
  return { sha: hashObject(type, data), object: { type, data } };
}

/** Store an object (idempotent) and return its SHA-1. */
export function storeObject(store: GitStore, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!store.objects.has(sha)) store.objects.set(sha, { type, data });
  return sha;
}

export function getObject(store: GitStore, sha: string): GitObject | undefined {
  return store.objects.get(sha);
}

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

export const DEFAULT_BRANCH = 'refs/heads/main';

/**
 * The repo's default branch: 'refs/heads/main' when it exists, else the
 * first refs/heads/* ref in sorted order, else 'refs/heads/main' (unborn).
 */
export function defaultBranch(store: GitStore): string {
  if (store.refs.has(DEFAULT_BRANCH)) return DEFAULT_BRANCH;
  const heads = [...store.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  return heads.length ? heads[0] : DEFAULT_BRANCH;
}

/**
 * Resolve a ref to its tip SHA-1. Accepts a full ref name
 * ('refs/heads/main'), 'HEAD' (the default branch), or a short branch name
 * ('main' -> 'refs/heads/main'). Returns undefined when the ref does not
 * exist or points at the zero oid.
 */
export function resolveRef(store: GitStore, ref: string): string | undefined {
  let name = ref;
  if (name === 'HEAD') name = defaultBranch(store);
  else if (!name.startsWith('refs/')) name = `refs/heads/${name}`;
  const oid = store.refs.get(name);
  if (!oid || oid === ZERO_OID) return undefined;
  return oid;
}

/** All refs sorted by name, as `[name, oid]` pairs. */
export function listRefs(store: GitStore): Array<[string, string]> {
  return [...store.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// builders (Builder B uses these for the contents API and PR merges)
// ---------------------------------------------------------------------------------------------

export interface BuildCommitOptions {
  readonly tree: string;
  readonly parents?: readonly string[];
  /** Commit message; a trailing newline is added when missing. */
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  /** Unix seconds (explicit, never Date.now()). */
  readonly timestamp: number;
  readonly timezone?: string;
}

/**
 * Build + store a commit. The author and committer lines are identical
 * (`<name> <email> <timestamp> <timezone>`). Returns the commit SHA-1.
 */
export function buildCommit(store: GitStore, options: BuildCommitOptions): string {
  const identity = `${options.authorName} <${options.authorEmail}>`;
  const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
  const data = buildCommitBytes({
    tree: options.tree,
    parents: options.parents ?? [],
    message,
    author: identity,
    committer: identity,
    timestamp: options.timestamp,
    timezone: options.timezone ?? '+0000',
  });
  return storeObject(store, 'commit', data);
}

export interface BuildTreeEntry {
  readonly name: string;
  /** git ASCII mode: '100644' file, '100755' executable, '40000' directory, '160000' gitlink. */
  readonly mode: string;
  readonly sha: string;
}

/**
 * Build + store a tree from entries (sorted the way git sorts them).
 * Returns the tree SHA-1.
 */
export function buildTree(store: GitStore, entries: ReadonlyArray<BuildTreeEntry>): string {
  const treeEntries: TreeEntry[] = entries.map((entry) => ({ mode: entry.mode, name: entry.name, oid: entry.sha }));
  return storeObject(store, 'tree', buildTreeBytes(treeEntries));
}

/** Store a blob and return its SHA-1. */
export function writeBlob(store: GitStore, content: Buffer): string {
  return storeObject(store, 'blob', content);
}

// ---------------------------------------------------------------------------------------------
// path reads (contents API)
// ---------------------------------------------------------------------------------------------

/**
 * Walk `path` (slash-separated, '' = the tree itself) from a ref tip's tree.
 * Returns the entry the path resolves to, or undefined when the ref, the
 * path, or any intermediate tree is missing.
 */
export function resolvePath(
  store: GitStore,
  ref: string,
  path: string,
): { mode: string; sha: string; type: GitObjectType } | undefined {
  const tip = resolveRef(store, ref);
  if (!tip) return undefined;
  const commit = getObject(store, tip);
  if (!commit || commit.type !== 'commit') return undefined;
  let treeOid: string;
  try {
    treeOid = parseCommit(commit.data).tree;
  } catch {
    return undefined;
  }
  const segments = path.split('/').filter((segment) => segment.length > 0);
  let currentOid = treeOid;
  let currentMode = '40000';
  for (const segment of segments) {
    const tree = getObject(store, currentOid);
    if (!tree || tree.type !== 'tree') return undefined;
    let entries: TreeEntry[];
    try {
      entries = parseTree(tree.data);
    } catch {
      return undefined;
    }
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) return undefined;
    currentOid = entry.oid;
    currentMode = entry.mode;
  }
  const object = getObject(store, currentOid);
  if (!object) return undefined;
  return { mode: currentMode, sha: currentOid, type: object.type };
}

/**
 * Read a blob at `path` under `ref`. Returns `{sha, content}` or undefined
 * when the ref/path does not exist or the path is not a blob.
 */
export function readBlobAtRef(
  store: GitStore,
  ref: string,
  path: string,
): { sha: string; content: Buffer } | undefined {
  const resolved = resolvePath(store, ref, path);
  if (!resolved || resolved.type !== 'blob') return undefined;
  const object = getObject(store, resolved.sha);
  if (!object) return undefined;
  return { sha: resolved.sha, content: object.data };
}

export interface TreeListEntry {
  readonly name: string;
  readonly mode: string;
  readonly sha: string;
  readonly type: GitObjectType;
}

/**
 * List the entries of the tree at `path` under `ref` ('' = the root tree).
 * Returns undefined when the ref/path does not exist or the path is a blob.
 */
export function listTreeAtRef(
  store: GitStore,
  ref: string,
  path: string,
): TreeListEntry[] | undefined {
  const resolved = resolvePath(store, ref, path);
  if (!resolved || resolved.type !== 'tree') return undefined;
  const tree = getObject(store, resolved.sha);
  if (!tree) return undefined;
  let entries: TreeEntry[];
  try {
    entries = parseTree(tree.data);
  } catch {
    return undefined;
  }
  const out: TreeListEntry[] = [];
  for (const entry of entries) {
    const object = getObject(store, entry.oid);
    out.push({
      name: entry.name,
      mode: entry.mode,
      sha: entry.oid,
      type: object?.type ?? (entry.mode === '40000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// PR squash merge
// ---------------------------------------------------------------------------------------------

export interface SquashCommitOptions {
  /** Identity for the squash commit; defaults to the head commit's author. */
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/**
 * Build the squash commit for merging a pull request: the commit's tree is
 * the head ref tip's tree, its single parent is the base ref tip, and the
 * message is the caller's. The author/committer come from the options, or
 * fall back to the head commit's author line (identity + timestamp), so the
 * result is deterministic. Returns the new commit SHA-1. The caller moves
 * the base ref to it; this function does not move any ref.
 * Throws when either ref is missing or does not point at a commit.
 */
export function createSquashCommit(
  store: GitStore,
  baseRef: string,
  headRef: string,
  message: string,
  options: SquashCommitOptions = {},
): string {
  const baseTip = resolveRef(store, baseRef);
  const headTip = resolveRef(store, headRef);
  if (!baseTip) throw new Error(`squash merge: base ref ${baseRef} does not exist`);
  if (!headTip) throw new Error(`squash merge: head ref ${headRef} does not exist`);
  const baseCommit = getObject(store, baseTip);
  const headCommit = getObject(store, headTip);
  if (!baseCommit || baseCommit.type !== 'commit') throw new Error(`squash merge: ${baseRef} is not a commit`);
  if (!headCommit || headCommit.type !== 'commit') throw new Error(`squash merge: ${headRef} is not a commit`);
  const headView = parseCommit(headCommit.data);
  let authorName = options.authorName;
  let authorEmail = options.authorEmail;
  let timestamp = options.timestamp;
  let timezone = options.timezone ?? '+0000';
  if (authorName === undefined || authorEmail === undefined || timestamp === undefined) {
    // Parse "Name <email> 1234567890 +0000" from the head commit's author.
    const match = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(headView.author);
    if (match) {
      authorName = authorName ?? match[1];
      authorEmail = authorEmail ?? match[2];
      timestamp = timestamp ?? Number.parseInt(match[3], 10);
      timezone = options.timezone ?? match[4];
    }
  }
  return buildCommit(store, {
    tree: headView.tree,
    parents: [baseTip],
    message,
    authorName: authorName ?? 'Forge',
    authorEmail: authorEmail ?? 'forge@localhost',
    timestamp: timestamp ?? 1700000000,
    timezone,
  });
}

export { isAncestor, peelToCommit, isObjectId };
