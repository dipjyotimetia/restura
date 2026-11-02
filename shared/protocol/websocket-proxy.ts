/**
 * Shared WebSocket protocol primitives. Backend-agnostic.
 *
 * Contains `validateWsUrl` (the SSRF + scheme gate used by the Worker and
 * Electron handlers) and base64 helpers for binary frames.
 *
 * Transport today: on Web the renderer connects browser-direct; on Desktop it
 * goes through IPC (`window.electron.websocket`). The Worker also exposes
 * `/api/ws-ticket` and `/api/ws` as a documented interface for self-hosters;
 * the renderer does not currently use them.
 */

import { base64ToBytes, bytesToBase64 } from './crypto-utils';
import { validateURL } from './url-validation';

export interface WsValidationOptions {
  allowLocalhost: boolean;
  /** Self-hosted opt-in for RFC 1918 / link-local / CGNAT WebSocket targets. */
  allowPrivateIPs?: boolean;
}

/** SSRF + scheme gate shared by Worker handler and Electron handler. */
export function validateWsUrl(
  url: string,
  opts: WsValidationOptions
): { ok: true; url: URL } | { ok: false; error: string } {
  const v = validateURL(url, {
    allowLocalhost: opts.allowLocalhost,
    allowPrivateIPs: opts.allowPrivateIPs === true,
    allowedSchemes: ['ws:', 'wss:'],
  });
  if (!v.valid) return { ok: false, error: v.error ?? 'invalid url' };
  return { ok: true, url: new URL(url) };
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buf));
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bytes = base64ToBytes(b64);
  // base64ToBytes always allocates a fresh ArrayBuffer-backed Uint8Array
  // (never SharedArrayBuffer), so the cast is sound.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
