/**
 * IPC wire encoding for binary WebSocket frames (desktop, #897).
 *
 * The renderer and the Electron main process exchange binary frame payloads
 * over IPC as strings. Both directions use standard base64, and both sides
 * import these two functions so the encoding cannot drift again (it once did:
 * the renderer sent space-separated hex while main decoded base64, corrupting
 * every desktop binary frame).
 *
 * Hex is purely a UI compose/display format and never crosses IPC.
 */
import { bytesToBase64 } from './binary';

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Encode a binary frame's bytes for IPC transport (base64). */
export function encodeWsBinaryFrame(data: ArrayBuffer | Uint8Array): string {
  return bytesToBase64(data instanceof Uint8Array ? data : new Uint8Array(data));
}

/** Decode an IPC binary frame payload (base64) back to bytes. Throws on non-base64 input. */
export function decodeWsBinaryFrame(encoded: string): Uint8Array<ArrayBuffer> {
  if (!BASE64_RE.test(encoded)) {
    throw new Error('Invalid binary frame payload: expected base64');
  }
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
