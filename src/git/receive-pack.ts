// git receive-pack over smart HTTP (protocol v0 only): unpack a pushed
// packfile, store its objects, and apply ref updates with per-ref
// fast-forward checks and a report-status answer.
//
// Wiring (Builder B owns the HTTP server and the repo registry):
//   handleReceivePack(store, req, res)  -- POST /{owner}/{repo}.git/git-receive-pack
// `store` is the repo's GitStore, or undefined when the repo does not exist
// (the handler then answers 404). The handler reads the request body itself
// and never throws: a malformed request gets a 400/500 response, never a crash.
//
// Rules (matched against the suite's git-client.ts):
// - The request body is pkt-line commands up to a flush, then a raw packfile
//   (absent for a delete-only push). The pack may use OFS_DELTA / REF_DELTA;
//   a thin pack's bases resolve against the store.
// - Every update must fast-forward: a non-fast-forward push is refused
//   per ref with "ng <ref> non-fast-forward" and the ref does not move.
//   A push carrying one fast-forward and one refused ref applies the
//   fast-forward ref and answers one report line per ref.
// - The report is pkt-lined ("unpack ok", then "ok <ref>" / "ng <ref> <reason>"
//   per command) inside sideband band 1, because the advertisement offers
//   report-status + side-band-64k (+ delete-refs, ofs-delta).
// - Unpack failure: "unpack <error>" and an "ng <ref> unpack failed" line
//   per command; no ref moves.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAncestor, isObjectId, peelToCommit, ZERO_OID } from './objects.ts';
import { readPack } from './pack.ts';
import { encodePktLines, encodeSideband, pktLineFlush, PktLineDecoder } from './pktline.ts';
import type { GitPacket } from './pktline.ts';
import { getObject, storeObject } from './store.ts';
import type { GitStore } from './store.ts';
import { handleInfoRefs, readRequestBody, sendRepoNotFound } from './upload-pack.ts';

// Re-exported so Builder B can serve both services' advertisements from
// either module; the implementation lives in upload-pack.ts.
export { handleInfoRefs };

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface RefVerdict {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Split a receive-pack body into its command list and its pack bytes.
 * Commands are pkt-lines up to the first flush; everything after that flush
 * is the raw packfile (possibly empty / absent for delete-only pushes).
 */
export function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const decoderPackets: GitPacket[] = [];
  // Walk the buffer with a decoder until the first flush, then take the rest raw.
  const decoder = new PktLineDecoder(body);
  let packStart = -1;
  for (;;) {
    const packet = decoder.next();
    if (packet === null) {
      decoder.finish();
      // No flush found: the whole body is commands (a malformed request
      // without a pack). Treat the buffered remainder as absent pack.
      packStart = body.length;
      break;
    }
    if (packet.kind === 'flush') {
      packStart = body.length - decoder.bufferedBytes;
      break;
    }
    decoderPackets.push(packet);
  }
  const commands: PushCommand[] = [];
  for (const packet of decoderPackets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    // The first command may carry "\0<capabilities>" after the ref name.
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command: ${JSON.stringify(line.slice(0, 80))}`);
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid)) {
      throw new Error(`receive-pack command has a bad object id: ${JSON.stringify(line.slice(0, 80))}`);
    }
    if (!ref.startsWith('refs/')) throw new Error(`receive-pack command has a bad ref: ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack sent no commands');
  return { commands, pack: packStart >= 0 ? body.subarray(packStart) : Buffer.alloc(0) };
}

/** Decide one ref update. Pure: reads the store, moves nothing. */
function judgeCommand(store: GitStore, command: PushCommand): RefVerdict {
  const current = store.refs.get(command.ref);
  const ng = (reason: string): RefVerdict => ({ ref: command.ref, ok: false, reason });
  const ok: RefVerdict = { ref: command.ref, ok: true, reason: '' };

  if (command.newOid === ZERO_OID) {
    // Delete.
    if (!current) return ng('ref does not exist');
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return ng('old oid does not match');
    return ok;
  }
  const newObject = getObject(store, command.newOid);
  if (!newObject) return ng('object not found');
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current) return ng('already exists');
    return ok;
  }
  if (!current) return ng('ref does not exist');
  if (command.oldOid !== current) return ng('old oid does not match');
  if (command.newOid === current) return ok; // no-op update
  // Fast-forward: the old tip (peeled to a commit) must be an ancestor of
  // the new tip (peeled to a commit).
  const lookup = (oid: string) => getObject(store, oid);
  const oldCommit = peelToCommit(command.oldOid, lookup) ?? command.oldOid;
  const newCommit = peelToCommit(command.newOid, lookup) ?? command.newOid;
  if (!isAncestor(oldCommit, newCommit, lookup)) return ng('non-fast-forward');
  return ok;
}

function sendReport(res: ServerResponse, unpackOk: boolean, unpackDetail: string, verdicts: RefVerdict[]): void {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const verdict of verdicts) {
    lines.push(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`);
  }
  lines.push('flush');
  const report = encodePktLines(lines);
  const body = Buffer.concat([encodeSideband(report, 1), pktLineFlush()]);
  if (res.writableEnded) return;
  res.writeHead(200, {
    'Content-Type': 'application/x-git-receive-pack-result',
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.writableEnded) return;
  const data = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(data.length) });
  res.end(data);
}

/**
 * POST /{owner}/{repo}.git/git-receive-pack (v0 only).
 * A missing repo (store undefined) answers 404 JSON.
 */
export async function handleReceivePack(
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
    const { commands, pack } = parseReceivePackBody(body);

    // Unpack: store every object from the pack. A thin pack's REF_DELTA
    // bases resolve against the objects already in the store.
    let unpackError: string | null = null;
    if (pack.length > 0) {
      try {
        const parsed = readPack(pack, { resolveBase: (oid) => getObject(store, oid) });
        for (const object of parsed.objects.values()) {
          storeObject(store, object.type, object.data);
        }
      } catch (err) {
        unpackError = (err as Error).message;
      }
    }
    if (unpackError) {
      sendReport(
        res,
        false,
        unpackError,
        commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
      );
      return;
    }

    // Judge each command, then apply only the accepted ones, in order.
    const verdicts = commands.map((command) => judgeCommand(store, command));
    for (let i = 0; i < commands.length; i += 1) {
      if (!verdicts[i].ok) continue;
      const command = commands[i];
      if (command.newOid === ZERO_OID) store.refs.delete(command.ref);
      else store.refs.set(command.ref, command.newOid);
    }
    sendReport(res, true, 'ok', verdicts);
  } catch (err) {
    const message = (err as Error).message;
    if (/pkt-line|truncated|invalid|bad receive-pack|no commands/.test(message)) {
      sendText(res, 400, `bad request: ${message}`);
    } else {
      sendText(res, 500, `internal error: ${message}`);
    }
  }
}
