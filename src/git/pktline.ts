// pkt-line framing (git smart-HTTP wire format) — pure TypeScript, Node stdlib only.
//
// A pkt-line is 4 hex ASCII length bytes (payload length + 4) followed by the
// payload. Special lengths: 0000 flush, 0001 delim, 0002 response-end.
// Maximum packet size is git's LARGE_PACKET_MAX (65520 bytes including header).
// Sideband (band 1 = data, 2 = progress, 3 = error) rides inside pkt-lines:
// the first payload byte is the band, the rest is the chunk.

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush' / 'delim' / 'response-end' are control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * An incremental pkt-line decoder. Push response chunks as they arrive;
 * `next()` returns a packet when one is complete and `null` when it needs
 * more bytes. `finish()` marks the stream ended and refuses trailing bytes.
 */
export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  get bufferedBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error('pkt-line decoder received bytes after finish()');
    if (!chunk.length) return;
    this.chunks.push(asBuffer(chunk));
    this.buffered += chunk.length;
  }

  finish(): void {
    this.ended = true;
  }

  get complete(): boolean {
    return this.ended && this.buffered === 0;
  }

  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0];
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const need = n - filled;
      if (need <= 0) break;
      const take = Math.min(need, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  private take(n: number): Buffer {
    if (this.buffered < n) throw new Error('pkt-line decoder underrun');
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** Remove and return every buffered byte (raw trailing data, e.g. a packfile). */
  takeBuffered(): Buffer {
    if (!this.buffered) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  next(): GitPacket | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) {
        throw new Error(`truncated pkt-line: ${this.buffered} trailing byte(s)`);
      }
      return null;
    }
    const header = this.peek(4)!;
    if (!HEX4.test(header.toString('ascii'))) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header.toString('ascii'))}`);
    }
    const length = Number.parseInt(header.toString('ascii'), 16);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end' };
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (this.buffered < length) {
      if (this.ended) {
        throw new Error(`truncated pkt-line: ${length} announced, ${this.buffered} available`);
      }
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }
}

/** Decode a complete buffer into packets; refuses trailing bytes. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const decoder = new PktLineDecoder(bytes);
  decoder.finish();
  const packets: GitPacket[] = [];
  for (;;) {
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
  }
  return packets;
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// sideband
// ---------------------------------------------------------------------------------------------

/** Sideband channel numbers: 1 = pack/data, 2 = progress, 3 = error. */
export type Sideband = 1 | 2 | 3;

/**
 * Wrap raw bytes into sideband pkt-lines on `band`, chunked so no pkt-line
 * exceeds the 64k sideband limit. Each packet is: 4 hex length + band byte +
 * up to 65515 bytes of payload (kept under the 65520 max with margin).
 */
export function encodeSideband(data: Uint8Array, band: Sideband): Buffer {
  const body = asBuffer(data);
  if (body.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < body.length; offset += CHUNK) {
    const slice = body.subarray(offset, Math.min(body.length, offset + CHUNK));
    const framed = Buffer.allocUnsafe(slice.length + 1);
    framed[0] = band;
    slice.copy(framed, 1);
    parts.push(encodePktLine(framed));
  }
  return Buffer.concat(parts);
}

/** One demultiplexed sideband packet. */
export interface SidebandPacket {
  readonly band: Sideband;
  readonly data: Buffer;
}

/**
 * Split pkt-line data packets into sideband packets. Non-sideband data
 * packets (band byte other than 1/2/3) are returned with band 0 so the
 * caller can treat them as plain lines.
 */
export function demuxSideband(packets: readonly GitPacket[]): Array<SidebandPacket | { readonly band: 0; readonly data: Buffer }> {
  const out: Array<SidebandPacket | { readonly band: 0; readonly data: Buffer }> = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload.length === 0) continue;
    const band = packet.payload[0];
    if (band === 1 || band === 2 || band === 3) {
      out.push({ band, data: packet.payload.subarray(1) });
    } else {
      out.push({ band: 0, data: packet.payload });
    }
  }
  return out;
}
