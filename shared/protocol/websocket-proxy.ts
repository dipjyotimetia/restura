/**
 * Shared WebSocket protocol primitives (Gap #5). Backend-agnostic.
 *
 * Both backends consume the same `WsTransport` contract:
 *   - WorkerWsTransport (web)      — opens `wss://api/.../ws?ticket=…`
 *   - ElectronWsTransport (desktop) — IPC over window.electron.websocket
 *
 * The Worker route piggybacks on the same SSRF / header policy / auth gate
 * that already protects /api/proxy, so the web build is no longer more
 * permissive than the desktop build for WebSocket traffic.
 *
 * Browser `WebSocket` can't set custom headers, so the renderer uses a
 * one-shot "ticket" handshake: POST /api/ws-ticket with the connect spec,
 * receive a short-lived ticket id, open `wss://...?ticket=<id>` against the
 * Worker. The Worker dereferences the ticket and applies the headers when
 * it opens the upstream connection.
 */

import { validateURL } from './url-validation';
import { base64ToBytes, bytesToBase64 } from './crypto-utils';

export interface WsConnectSpec {
  url: string;
  protocols?: string[];
  headers?: Record<string, string>;
}

export interface WsTransport {
  connect(id: string, spec: WsConnectSpec): Promise<void>;
  send(id: string, payload: string | ArrayBuffer): boolean;
  disconnect(id: string, code?: number, reason?: string): void;
  onOpen(id: string, cb: () => void): void;
  onMessage(id: string, cb: (data: string | ArrayBuffer) => void): void;
  onError(id: string, cb: (err: Error) => void): void;
  onClose(id: string, cb: (code: number, reason: string) => void): void;
}

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
