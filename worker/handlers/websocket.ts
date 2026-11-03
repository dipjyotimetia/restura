/**
 * `GET /api/ws?ticket=<id>` — WebSocket upgrade handler (Gap #5). Accepts the
 * client side of a `WebSocketPair`, dereferences the one-shot ticket created
 * by `/api/ws-ticket`, opens the upstream WebSocket via the documented
 * Workers `fetch(target, { headers: { Upgrade: 'websocket' } })` pattern,
 * pipes messages bidirectionally with a 1MB per-frame cap.
 *
 * Worker is a transparent pass-through: no payload inspection, no JSON
 * parsing. Same SSRF / header policy applies as for /api/proxy.
 */

import { sanitizeRequestHeaders } from '@shared/protocol/header-policy';
import { validateWsUrl } from '@shared/protocol/websocket-proxy';
import type { Context } from 'hono';
import type { Env } from '../env';
import { isLocalDevBypass, allowPrivateIPs as readAllowPrivateIPs } from '../shared/env';
import { consumeTicket } from './ws-ticket';

const MAX_FRAME_BYTES = 1 * 1024 * 1024; // mirror Electron's MAX_MESSAGE_SIZE
// Hoisted: TextEncoder is stateless, allocating one per frame would churn GC.
const TEXT_ENCODER = new TextEncoder();

/** RFC 6455 §5.5: a close frame's reason is at most 123 UTF-8 bytes. */
const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Map a close code received from one side to one the other side may send.
 * 1004/1005/1006/1015 (and anything outside 1000–1014 / 3000–4999) can be
 * observed but never sent: `ws` throws TypeError and workerd rejects them, and
 * a swallowed throw leaves the peer open. Such codes relay as 1000. Shared by
 * the Cloudflare and Node relays.
 */
export function relayCloseCode(code: number): number {
  const sendable =
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

/**
 * Truncate a close reason to ≤123 UTF-8 bytes (longer makes close() throw)
 * without splitting a character. O(n) over the string, no allocation unless
 * it truncates. A lone surrogate counts as its 3-byte U+FFFD replacement.
 */
export function closeReason(text: string): string {
  // Every UTF-16 unit encodes to at most 3 bytes.
  if (text.length * 3 <= MAX_CLOSE_REASON_BYTES) return text;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    let size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    let units = 1;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        size = 4;
        units = 2;
      }
    }
    if (bytes + size > MAX_CLOSE_REASON_BYTES) return text.slice(0, i);
    bytes += size;
    i += units - 1;
  }
  return text;
}

/** Message of an unknown thrown value, for a close reason or log line. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Cloudflare-runtime augmentations the global lib.dom doesn't ship: WebSocket
// has .accept() / .send() on both ends of a pair, fetch() Response gains
// .webSocket when upstream upgrades. Declared inline so we don't pull in
// @cloudflare/workers-types into the shared package.
interface CfWebSocket {
  accept(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', cb: (ev: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: 'close', cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
declare const WebSocketPair: any;

export async function websocketHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'Upgrade: websocket required' }, 426);
  }
  const ticket = c.req.query('ticket');
  if (!ticket) {
    return c.json({ error: 'Missing ticket query param' }, 400);
  }
  const spec = consumeTicket(ticket);
  if (!spec) {
    return c.json({ error: 'Invalid or expired ticket' }, 401);
  }

  const allowLocalhost = isLocalDevBypass(c.env);
  const allowPrivateIPs = readAllowPrivateIPs(c.env);
  const validation = validateWsUrl(spec.target, { allowLocalhost, allowPrivateIPs });
  if (!validation.ok) {
    return c.json({ error: `Invalid target: ${validation.error}` }, 400);
  }

  const pair = new WebSocketPair() as Record<'0' | '1', CfWebSocket>;
  const client = pair[0];
  const server = pair[1];
  server.accept();

  // 101 Switching Protocols handing the client socket back to the runtime.
  // `ResponseInit.webSocket` is typed by the Worker lib as the full `WebSocket`;
  // our narrow `CfWebSocket` only models the members we use, so the single cast
  // here bridges that gap (vs. the previous `as unknown as ResponseInit` ×3).
  const upgradeResponse = (): Response =>
    new Response(null, { status: 101, webSocket: client as unknown as WebSocket });

  // Open the upstream via fetch() with Upgrade header — documented Workers
  // pattern for outbound WS-client connections.
  const upstreamUrl = spec.target.replace(/^ws/, 'http');
  const sanitisedHeaders = sanitizeRequestHeaders({
    Upgrade: 'websocket',
    ...(spec.protocols && spec.protocols.length > 0
      ? { 'Sec-WebSocket-Protocol': spec.protocols.join(',') }
      : {}),
    ...(spec.headers ?? {}),
  });
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, { headers: sanitisedHeaders, redirect: 'manual' });
  } catch (err) {
    server.close(1011, closeReason(`Upstream connect failed: ${errorText(err)}`));
    return upgradeResponse();
  }
  const upstream = upstreamRes.webSocket as CfWebSocket | null;
  if (!upstream) {
    server.close(1002, 'Upstream did not upgrade');
    return upgradeResponse();
  }
  upstream.accept();

  // Bidirectional pipe with frame-size cap. Fast-path string frames via
  // char-length × 4 (UTF-8 max bytes/codepoint) before encoding; only when
  // the upper-bound is over budget do we actually encode to count.
  const sizeOf = (data: string | ArrayBuffer): number => {
    if (typeof data === 'string') {
      if (data.length * 4 <= MAX_FRAME_BYTES) return data.length;
      return TEXT_ENCODER.encode(data).byteLength;
    }
    return data.byteLength;
  };
  const pipe = (src: CfWebSocket, dst: CfWebSocket): void => {
    src.addEventListener('message', (ev) => {
      if (sizeOf(ev.data) > MAX_FRAME_BYTES) {
        src.close(1009, 'Frame too large');
        dst.close(1009);
        return;
      }
      try {
        dst.send(ev.data);
      } catch {
        /* peer closed */
      }
    });
    src.addEventListener('close', (ev) => {
      try {
        dst.close(relayCloseCode(ev.code), closeReason(ev.reason));
      } catch {
        /* already closed */
      }
    });
  };
  pipe(server, upstream);
  pipe(upstream, server);

  return upgradeResponse();
}
