// git upload-pack over smart HTTP: ref advertisement (v0 + v2), v2 ls-refs,
// and fetch (v2 and v0, with shallow/deepen support).
//
// Wiring (Builder B owns the HTTP server and the repo registry):
//   handleInfoRefs(store, service, req, res)   -- GET /{owner}/{repo}.git/info/refs?service=...
//   handleUploadPack(store, req, res)          -- POST /{owner}/{repo}.git/git-upload-pack
// `store` is the repo's GitStore, or undefined when the repo does not exist
// (the handler then answers 404 and the server stays up). The handlers read
// the request body themselves and never throw: a malformed request gets a
// 400/500 response, never a crash.
//
// Protocol notes (matched against the suite's git-client.ts):
// - v2 is used when the request carries `Git-Protocol: version=2`; otherwise v0.
// - v2 advertisement: "# service=git-upload-pack" preamble, then "version 2"
//   and capability lines (ls-refs=unborn, fetch=shallow, object-format=sha1).
// - v0 advertisement: preamble, then "<oid> <ref>\0<caps>" first line, peeled
//   tags as "<oid> <ref>^{}", HEAD first, and for an empty repo the
//   "capabilities^{}" pseudo-ref. Capabilities include side-band-64k,
//   thin-pack, ofs-delta, shallow, multi_ack and symref=HEAD:<default>.
// - v2 fetch answers sections: acknowledgments (only when the client sent
//   haves: ACKs + "ready", or NAK), shallow-info when the boundary moved,
//   packfile (sideband band 1). Sections are separated by delim (0001) and
//   the response ends with flush (0000). A clone with no haves goes straight
//   to packfile — real git dies with "expected 'packfile'" otherwise.
// - v0 fetch answers NAK, shallow/unshallow lines, then the sideband pack.
// - Packs carry plain objects only (no deltas); a 0-object pack is a valid
//   32-byte pack (12-byte header + 20-byte trailer).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectReachable, isObjectId, parseCommit, parseTag, parseTree, peelToTarget, ZERO_OID } from './objects.ts';
import type { GitObject, GitObjectType } from './objects.ts';
import { writePack } from './pack.ts';
import { decodePktLines, encodePktLine, encodePktLines, encodeSideband, pktLineDelim, pktLineFlush } from './pktline.ts';
import type { GitPacket } from './pktline.ts';
import { defaultBranch, getObject } from './store.ts';
import type { GitStore } from './store.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

const AGENT = 'forge/1.0';

/** Read a whole request body into a Buffer. */
export async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(data.length) });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.writableEnded) return;
  const data = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(data.length) });
  res.end(data);
}

function sendBinary(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.length) });
  res.end(body);
}

/** 404 for a missing repository (JSON, so the server stays up and healthy). */
export function sendRepoNotFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'repository not found' });
}

// ---------------------------------------------------------------------------------------------
// ref advertisement
// ---------------------------------------------------------------------------------------------

function uploadPackCapabilities(store: GitStore): string {
  return [
    `symref=HEAD:${defaultBranch(store)}`,
    'multi_ack',
    'multi_ack_detailed',
    'thin-pack',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    `agent=${AGENT}`,
    'object-format=sha1',
  ].join(' ');
}

function receivePackCapabilities(): string {
  return ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
}

/** Peel an annotated tag ref to its target commit oid, or undefined. */
function peelRef(store: GitStore, oid: string): string | undefined {
  const object = getObject(store, oid);
  if (!object || object.type !== 'tag') return undefined;
  try {
    const target = parseTag(object.data).object;
    const peeled = peelToTarget(target, (id) => getObject(store, id));
    return peeled?.type === 'commit' ? peeled.oid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The v0 ref advertisement body for a service, including the
 * "# service=..." preamble. Sorted refs, HEAD first, peeled tags as "^{}".
 */
export function buildV0Advertisement(store: GitStore, service: GitService): Buffer {
  const capabilities = service === 'git-upload-pack' ? uploadPackCapabilities(store) : receivePackCapabilities();
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  const refs = [...store.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  } else {
    const defaultTip = store.refs.get(defaultBranch(store)) ?? refs[0][1];
    let first = true;
    const line = (text: string): Buffer => {
      if (first) {
        first = false;
        return encodePktLine(`${text}\u0000${capabilities}\n`);
      }
      return encodePktLine(`${text}\n`);
    };
    parts.push(line(`${defaultTip} HEAD`));
    for (const [name, oid] of refs) {
      parts.push(line(`${oid} ${name}`));
      const peeled = peelRef(store, oid);
      if (peeled) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body (service preamble + "version 2"). */
export function buildV2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=<service>.
 * Answers v2 when the request carries `Git-Protocol: version=2` (upload-pack
 * only); otherwise v0. A missing repo (store undefined) answers 404 JSON.
 */
export async function handleInfoRefs(
  store: GitStore | undefined,
  service: GitService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (!store) {
      sendRepoNotFound(res);
      return;
    }
    const wantsV2 =
      service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    if (wantsV2) {
      sendBinary(res, 200, 'application/x-git-upload-pack-advertisement', buildV2Advertisement());
    } else {
      sendBinary(res, 200, `application/x-${service}-advertisement`, buildV0Advertisement(store, service));
    }
  } catch (err) {
    sendText(res, 500, `internal error: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to pack, keyed by oid (deterministic order is the caller's). */
  readonly objects: Map<string, GitObject>;
  /** New shallow boundary commits (depth cutoff). */
  readonly shallow: string[];
  /** Former shallow commits that are no longer shallow. */
  readonly unshallow: string[];
}

function lookupOf(store: GitStore): (oid: string) => GitObject | undefined {
  return (oid: string) => getObject(store, oid);
}

/**
 * Decide what a fetch sends.
 *
 * - Roots are the wants, peeled through tags (tag objects themselves are
 *   sent as direct objects). Non-commit wants (tree/blob) are sent directly.
 * - With `depth`, only commits fewer than `depth` generations from a want
 *   are included; the cutoff commits become the new shallow boundary.
 *   Without depth, the full reachable closure is included.
 * - Objects reachable from `haves` are not re-sent — except that a have
 *   that is also one of the client's shallow boundaries does not block the
 *   deepen: the server must send the generations beyond it. So the
 *   effective have-set is `haves` minus `shallowInput`.
 * - `unshallow` is every old shallow boundary that is now included with all
 *   of its parents included.
 */
export function planFetch(
  store: GitStore,
  wants: readonly string[],
  haves: readonly string[],
  shallowInput: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const lookup = lookupOf(store);
  const directObjects = new Map<string, GitObject>();
  const roots: string[] = [];
  for (const want of wants) {
    const object = getObject(store, want);
    if (!object) throw new Error(`object not found: ${want}`);
    if (object.type === 'tag') {
      directObjects.set(want, object);
      // Peel through tag chains, keeping every intermediate tag object.
      let current = want;
      for (let hops = 0; hops < 16; hops += 1) {
        const tag = getObject(store, current);
        if (!tag || tag.type !== 'tag') break;
        let target: string;
        try {
          target = parseTag(tag.data).object;
        } catch {
          throw new Error(`malformed tag object: ${current}`);
        }
        const targetObject = getObject(store, target);
        if (!targetObject) throw new Error(`object not found: ${target}`);
        if (targetObject.type === 'tag') {
          directObjects.set(target, targetObject);
          current = target;
          continue;
        }
        if (targetObject.type === 'commit') roots.push(target);
        else directObjects.set(target, targetObject);
        break;
      }
    } else if (object.type === 'commit') {
      roots.push(want);
    } else {
      directObjects.set(want, object);
    }
  }

  // BFS over parents from the roots, tracking the distance from the nearest root.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!distance.has(root)) {
      distance.set(root, 0);
      queue.push(root);
    }
  }
  const included = new Set<string>();
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head];
    const dist = distance.get(oid)!;
    if (depth !== undefined && dist >= depth) continue;
    included.add(oid);
    const object = getObject(store, oid);
    if (!object || object.type !== 'commit') continue;
    let parents: string[];
    try {
      parents = parseCommit(object.data).parents;
    } catch {
      throw new Error(`malformed commit object: ${oid}`);
    }
    for (const parent of parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }

  // New shallow boundary: included commits whose parents are not all
  // included (the depth cutoff). With a depth limit a root commit with no
  // parents is a boundary too, matching git's shallow file.
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of included) {
      const object = getObject(store, oid);
      if (!object || object.type !== 'commit') continue;
      let parents: string[];
      try {
        parents = parseCommit(object.data).parents;
      } catch {
        continue;
      }
      if (parents.length === 0 || parents.some((parent) => !included.has(parent))) shallow.push(oid);
    }
  }
  const shallowSet = new Set(shallow);
  const unshallow = shallowInput.filter((oid) => included.has(oid) && !shallowSet.has(oid));

  // Objects: each included commit + its tree closure, plus direct objects.
  const objects = new Map<string, GitObject>();
  for (const [oid, object] of directObjects) objects.set(oid, object);
  const treeStack: string[] = [];
  for (const oid of included) {
    const commit = getObject(store, oid);
    if (!commit) continue;
    objects.set(oid, commit);
    if (commit.type !== 'commit') continue;
    let tree: string;
    try {
      tree = parseCommit(commit.data).tree;
    } catch {
      continue;
    }
    treeStack.push(tree);
  }
  while (treeStack.length) {
    const treeOid = treeStack.pop()!;
    if (objects.has(treeOid)) continue;
    const tree = getObject(store, treeOid);
    if (!tree) continue;
    objects.set(treeOid, tree);
    if (tree.type !== 'tree') continue;
    let entries;
    try {
      entries = parseTree(tree.data);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.mode === '160000') continue; // gitlink
      const child = getObject(store, entry.oid);
      if (!child) continue;
      if (child.type === 'tree') treeStack.push(entry.oid);
      else objects.set(entry.oid, child);
    }
  }

  // Do not re-send what the client already holds (haves minus shallow input).
  const shallowInputSet = new Set(shallowInput);
  const effectiveHaves = haves.filter((oid) => !shallowInputSet.has(oid));
  if (effectiveHaves.length) {
    const held = collectReachable(effectiveHaves, lookup, { allowMissing: true });
    for (const oid of held) objects.delete(oid);
  }

  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// POST git-upload-pack
// ---------------------------------------------------------------------------------------------

function dataLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

interface V2Command {
  readonly command: string;
  readonly args: string[];
}

/** Parse a v2 request body: `command=<name>`, optional headers, delim, args, flush. */
function parseV2Request(body: Buffer): V2Command {
  const packets = decodePktLines(body);
  const lines = dataLines(packets);
  if (lines.length === 0) throw new Error('empty protocol v2 request');
  const first = lines[0].replace(/\n$/, '');
  if (!first.startsWith('command=')) throw new Error(`expected a v2 command, got ${JSON.stringify(first.slice(0, 40))}`);
  const command = first.slice('command='.length);
  // Args start after the delim packet; everything before it is a header.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
  const args: string[] = [];
  for (const packet of argPackets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return { command, args };
}

function packSideband(objects: Map<string, GitObject>): Buffer {
  const sorted = [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const pack = writePack(sorted.map(([, object]) => object));
  return encodeSideband(pack, 1);
}

/** Send a v2 fetch error: a packfile section carrying a band-3 sideband error. */
function sendV2FetchError(res: ServerResponse, message: string): void {
  const body = Buffer.concat([
    encodePktLines(['packfile\n']),
    encodeSideband(Buffer.from(`${message}\n`, 'utf8'), 3),
    pktLineFlush(),
  ]);
  sendBinary(res, 200, 'application/x-git-upload-pack-result', body);
}

function handleFetchV2(store: GitStore, args: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowInput: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowInput.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'thin-pack' || arg === 'no-progress' || arg === 'ofs-delta' || arg === 'done') continue;
    else if (arg.startsWith('filter ')) throw new Error(`unsupported fetch filter: ${arg}`);
    else if (arg.startsWith('deepen-since ') || arg.startsWith('deepen-not ')) {
      throw new Error(`unsupported fetch argument: ${arg}`);
    }
    // Unknown arguments are ignored (forward compatibility).
  }
  for (const oid of [...wants, ...haves, ...shallowInput]) {
    if (!isObjectId(oid)) throw new Error(`bad object id in fetch: ${JSON.stringify(oid)}`);
  }
  let plan: FetchPlan;
  try {
    plan = planFetch(store, wants, haves, shallowInput, depth);
  } catch (err) {
    sendV2FetchError(res, (err as Error).message);
    return;
  }
  // The acknowledgments section exists only when the client negotiated
  // (sent haves): a clone with no haves goes straight to the packfile
  // section — real git dies with "expected 'packfile'" otherwise.
  // With haves, answer ACK for every have the store holds, then "ready";
  // with no common have, answer NAK.
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    const acked = haves.filter((oid) => getObject(store, oid) !== undefined);
    const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
    if (acked.length) {
      for (const oid of acked) ackLines.push(`ACK ${oid}\n`);
      ackLines.push('ready\n');
    } else {
      ackLines.push('NAK\n');
    }
    ackLines.push('delim');
    parts.push(encodePktLines(ackLines));
  }
  if (plan.shallow.length || plan.unshallow.length) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLines(['packfile\n']));
  parts.push(packSideband(plan.objects));
  parts.push(pktLineFlush());
  sendBinary(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleLsRefsV2(store: GitStore, args: string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const refs = [...store.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const defaultRef = defaultBranch(store);
  if (refs.length === 0) {
    // Empty repo: only an unborn HEAD line, and only when it matches the filter.
    if (unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`);
    }
  } else {
    const defaultTip = store.refs.get(defaultRef) ?? refs[0][1];
    if (keep('HEAD')) {
      lines.push(`${defaultTip} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`);
    }
    for (const [name, oid] of refs) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      if (peel) {
        const peeled = peelRef(store, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  sendBinary(res, 200, 'application/x-git-upload-pack-result', encodePktLines(lines));
}

function handleFetchV0(store: GitStore, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const lines = dataLines(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowInput: string[] = [];
  let depth: number | undefined;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after the oid.
      wants.push(line.slice(5).trim().split(' ')[0]);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowInput.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') continue;
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      throw new Error(`unsupported fetch argument: ${line}`);
    }
  }
  for (const oid of [...wants, ...haves, ...shallowInput]) {
    if (!isObjectId(oid)) throw new Error(`bad object id in fetch: ${JSON.stringify(oid)}`);
  }
  let plan: FetchPlan;
  try {
    plan = planFetch(store, wants, haves, shallowInput, depth);
  } catch (err) {
    const bodyOut = Buffer.concat([
      encodePktLines(['NAK\n']),
      encodeSideband(Buffer.from(`${(err as Error).message}\n`, 'utf8'), 3),
      pktLineFlush(),
    ]);
    sendBinary(res, 200, 'application/x-git-upload-pack-result', bodyOut);
    return;
  }
  const parts: Buffer[] = [];
  // multi_ack_detailed negotiation, mirroring real git: one
  // "ACK <oid> common" per have the store holds, then a bare "ACK <oid>"
  // (the ready signal) for the last of them; NAK when nothing is common.
  const acked = haves.filter((oid) => getObject(store, oid) !== undefined);
  if (acked.length) {
    const ackLines: string[] = acked.map((oid) => `ACK ${oid} common\n`);
    ackLines.push(`ACK ${acked[acked.length - 1]}\n`);
    parts.push(encodePktLines(ackLines));
  } else {
    parts.push(encodePktLines(['NAK\n']));
  }
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(packSideband(plan.objects));
  parts.push(pktLineFlush());
  sendBinary(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/**
 * POST /{owner}/{repo}.git/git-upload-pack.
 * v2 when the request carries `Git-Protocol: version=2`, else v0.
 * A missing repo (store undefined) answers 404 JSON.
 */
export async function handleUploadPack(
  store: GitStore | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (!store) {
      sendRepoNotFound(res);
      return;
    }
    const body = await readRequestBody(req);
    const isV2 = req.headers['git-protocol'] === 'version=2';
    if (isV2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') handleLsRefsV2(store, args, res);
      else if (command === 'fetch') handleFetchV2(store, args, res);
      else sendText(res, 400, `unsupported protocol v2 command: ${command}`);
    } else {
      handleFetchV0(store, body, res);
    }
  } catch (err) {
    // A malformed pkt-line (or any other parse failure) is a 400; the
    // server stays up. Anything else is a 500. Never throw out of the handler.
    const message = (err as Error).message;
    if (/pkt-line|truncated|invalid|bad object id|empty protocol|expected a v2/.test(message)) {
      sendText(res, 400, `bad request: ${message}`);
    } else {
      sendText(res, 500, `internal error: ${message}`);
    }
  }
}
