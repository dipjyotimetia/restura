/**
 * gRPC-Web wire framing (PROTOCOL-WEB.md). Runtime-neutral — used by the
 * shared gRPC-Web proxy (Worker / Node self-host) and by the renderer to
 * decode the relayed message payloads.
 *
 * A gRPC-Web body is a sequence of length-prefixed frames:
 *
 *   flags (1 byte) | length (4 bytes, big-endian) | payload (length bytes)
 *
 * Flag bit 0x80 marks the trailer frame (HTTP/1-style `key: value\r\n`
 * lines), bit 0x01 marks a compressed payload. `application/grpc-web-text`
 * is the same byte stream base64-encoded, where the server may concatenate
 * independently padded base64 chunks.
 */

export const GRPC_WEB_TRAILER_FLAG = 0x80;
export const GRPC_WEB_COMPRESSED_FLAG = 0x01;
const HEADER_BYTES = 5;

export interface GrpcWebFrame {
  flags: number;
  data: Uint8Array;
}

export class GrpcWebFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrpcWebFramingError';
  }
}

/** Wrap one payload in a gRPC-Web frame. */
export function encodeGrpcWebFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out[0] = flags & 0xff;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, HEADER_BYTES);
  return out;
}

/**
 * Incremental frame decoder. Feed arbitrary chunks; complete frames come out
 * as soon as their last byte arrives. `maxFrameBytes` rejects an oversized
 * declared length up front, before the bytes are buffered.
 */
export class GrpcWebFrameDecoder {
  private buffer = new Uint8Array(0);

  constructor(private readonly maxFrameBytes: number = Number.POSITIVE_INFINITY) {}

  push(chunk: Uint8Array): GrpcWebFrame[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    const frames: GrpcWebFrame[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= HEADER_BYTES) {
      const flags = this.buffer[offset] as number;
      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + offset + 1,
        4
      ).getUint32(0, false);
      if (length > this.maxFrameBytes) {
        throw new GrpcWebFramingError(
          `gRPC-Web frame of ${length} bytes exceeds the ${this.maxFrameBytes}-byte limit`
        );
      }
      if (this.buffer.length - offset - HEADER_BYTES < length) break;
      const start = offset + HEADER_BYTES;
      frames.push({ flags, data: this.buffer.slice(start, start + length) });
      offset = start + length;
    }
    if (offset > 0) this.buffer = this.buffer.slice(offset);
    return frames;
  }

  /** Bytes received that don't yet form a complete frame. */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}

/**
 * Parse a trailer frame payload (`key: value\r\n` lines) into a lower-cased
 * record. Repeated keys are comma-joined, like HTTP header folding.
 */
export function parseGrpcWebTrailers(data: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(data);
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = out[key] === undefined ? value : `${out[key]}, ${value}`;
  }
  return out;
}

/** Percent-decode a `grpc-message` value (the spec's only escaping). */
export function decodeGrpcMessage(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// base64 helpers (btoa/atob exist in Workers, Node >= 16 and browsers)
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** True for a well-formed (padded) standard base64 string. */
export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_RE.test(value);
}

/**
 * Incremental `application/grpc-web-text` decoder. Decodes in 4-character
 * quanta so concatenated, independently padded base64 chunks decode
 * correctly; whitespace is ignored.
 */
export class GrpcWebTextDecoder {
  private pending = '';
  private readonly utf8 = new TextDecoder();

  push(chunk: Uint8Array): Uint8Array {
    this.pending += this.utf8.decode(chunk, { stream: true }).replace(/\s+/g, '');
    const usable = this.pending.length - (this.pending.length % 4);
    if (usable === 0) return new Uint8Array(0);
    const quanta = this.pending.slice(0, usable);
    this.pending = this.pending.slice(usable);
    const parts: Uint8Array[] = [];
    // Split at padding boundaries: a padded quantum ends one base64 chunk.
    let start = 0;
    for (let i = 0; i < quanta.length; i += 4) {
      if (quanta[i + 3] === '=') {
        parts.push(decodeQuanta(quanta.slice(start, i + 4)));
        start = i + 4;
      }
    }
    if (start < quanta.length) parts.push(decodeQuanta(quanta.slice(start)));
    return concatBytes(parts);
  }

  /** Characters left over that don't form a full base64 quantum. */
  get pendingChars(): number {
    return this.pending.length;
  }
}

function decodeQuanta(b64: string): Uint8Array {
  if (!BASE64_RE.test(b64)) {
    throw new GrpcWebFramingError('Malformed base64 in application/grpc-web-text response');
  }
  return base64ToBytes(b64);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
