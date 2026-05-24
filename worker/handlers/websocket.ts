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

import type { Context } from 'hono';
import type { Env } from '../env';
import { consumeTicket } from './ws-ticket';
import { validateWsUrl } from '@shared/protocol/websocket-proxy';
import { sanitizeRequestHeaders } from '@shared/protocol/header-policy';
import { allowPrivateIPs as readAllowPrivateIPs, isLocalDevBypass } from '../shared/env';

const MAX_FRAME_BYTES = 1 * 1024 * 1024; // mirror Electron's MAX_MESSAGE_SIZE
// Hoisted: TextEncoder is stateless, allocating one per frame would churn GC.
const TEXT_ENCODER = new TextEncoder();

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    upstreamRes = await fetch(upstreamUrl, { headers: sanitisedHeaders });
  } catch (err) {
    server.close(1011, `Upstream connect failed: ${(err as Error).message}`);
    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upstream = (upstreamRes as any).webSocket as CfWebSocket | undefined;
  if (!upstream) {
    server.close(1002, 'Upstream did not upgrade');
    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
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
      try { dst.send(ev.data); } catch { /* peer closed */ }
    });
    src.addEventListener('close', (ev) => {
      try { dst.close(ev.code, ev.reason); } catch { /* already closed */ }
    });
  };
  pipe(server, upstream);
  pipe(upstream, server);

  return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
}
