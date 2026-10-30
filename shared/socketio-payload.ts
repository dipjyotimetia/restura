/**
 * Socket.IO argument shaping shared by the renderer `socketioManager` (web)
 * and the Electron `socketio-handler` (desktop), so both paths split server
 * ack callbacks, encode binary and enforce the incoming size cap identically.
 * Runtime-neutral: only `btoa`/`atob`/`TextEncoder`, available in browsers,
 * Workers and Node.
 */

/**
 * Largest incoming event payload forwarded to the event log (bytes). Matches
 * the WebSocket handler's `maxPayload`. Larger events are replaced by a
 * placeholder before they reach IPC or the store.
 */
export const SOCKETIO_MAX_INCOMING_BYTES = 1024 * 1024;

/** JSON stand-in for a binary attachment: `{ "$binary": "<base64>" }`. */
export interface SocketIOBinaryMarker {
  $binary: string;
}

type AckCallback = (...args: unknown[]) => void;

const MAX_DEPTH = 32;

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isBinaryMarker(value: unknown): value is SocketIOBinaryMarker {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $binary?: unknown }).$binary === 'string'
  );
}

/**
 * Replace every binary attachment (ArrayBuffer / typed array / Buffer) with a
 * `{ $binary }` marker so the value is JSON- and IPC-safe for the event log.
 */
export function encodeBinaryArgs<T>(value: T, depth = 0): T {
  if (isBinary(value)) return { $binary: bytesToBase64(toBytes(value)) } as T;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => encodeBinaryArgs(v, depth + 1)) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = encodeBinaryArgs(v, depth + 1);
  return out as T;
}

/**
 * Inverse of {@link encodeBinaryArgs}: turn `{ $binary: "<base64>" }` markers
 * typed in the composer into `Uint8Array`s, which socket.io sends as binary
 * attachments. Throws on invalid base64.
 */
export function decodeBinaryArgs<T>(value: T, depth = 0): T {
  if (isBinaryMarker(value)) {
    try {
      return base64ToBytes(value.$binary) as T;
    } catch {
      throw new Error('Invalid base64 in $binary argument');
    }
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => decodeBinaryArgs(v, depth + 1)) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decodeBinaryArgs(v, depth + 1);
  return out as T;
}

/** True when any argument (at any depth) is a `{ $binary }` marker. */
export function hasBinaryMarker(value: unknown, depth = 0): boolean {
  if (isBinaryMarker(value)) return true;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
  return children.some((v) => hasBinaryMarker(v, depth + 1));
}

/** Approximate wire size of event args: binary byte length + UTF-8 JSON for the rest. */
export function payloadByteSize(args: unknown[]): number {
  let binaryBytes = 0;
  let json = '';
  try {
    json =
      JSON.stringify(args, (_key, v: unknown) => {
        if (isBinary(v)) {
          binaryBytes += v.byteLength;
          return null;
        }
        return v;
      }) ?? '';
  } catch {
    json = '';
  }
  return binaryBytes + new TextEncoder().encode(json).length;
}

export interface IncomingSocketIOEvent {
  /** Log-safe args (binary encoded, functions stripped, oversize replaced). */
  args: unknown[];
  /** Server-requested acknowledgement callback, if the server asked for one. */
  ack?: AckCallback;
  /** Set when the payload exceeded {@link SOCKETIO_MAX_INCOMING_BYTES}. */
  oversizeBytes?: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shape an `onAny` delivery for the log. socket.io-client appends the ack
 * callback as the last argument when the server emitted with one; it is split
 * off here so a function never lands in an IPC payload or the store.
 */
export function prepareIncomingArgs(
  rawArgs: unknown[],
  maxBytes: number = SOCKETIO_MAX_INCOMING_BYTES
): IncomingSocketIOEvent {
  const last = rawArgs[rawArgs.length - 1];
  const ack = typeof last === 'function' ? (last as AckCallback) : undefined;
  const args = ack ? rawArgs.slice(0, -1) : rawArgs;
  const size = payloadByteSize(args);
  if (size > maxBytes) {
    return {
      args: [`[payload omitted: ${formatBytes(size)} exceeds the ${formatBytes(maxBytes)} limit]`],
      ...(ack ? { ack } : {}),
      oversizeBytes: size,
    };
  }
  return { args: encodeBinaryArgs(args), ...(ack ? { ack } : {}) };
}
