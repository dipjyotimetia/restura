/**
 * Node implementation of `GET /api/ws?ticket=<id>` — the WebSocket upgrade
 * handler. Mirrors `worker/handlers/websocket.ts` (Cloudflare version) but
 * uses `@hono/node-ws` for the client-side accept and the `ws` library for
 * the upstream client connection.
 *
 * Same SSRF + ticket policy as the Cloudflare variant: ticket consumed once,
 * target URL re-validated, 1 MiB per-frame cap, no payload inspection.
 *
 * Key implementation choices:
 *   - The ticket is consumed inside `onOpen` (after the upgrade succeeded),
 *     not inside `createEvents`. createEvents runs for any GET that hits
 *     `/api/ws`, including non-upgrade probes; consuming there would burn
 *     the one-shot ticket without opening a WebSocket.
 *   - DNS-resolution SSRF guard runs on the upstream hostname before the
 *     `new WebSocket(...)` call. Defends against attacker-controlled DNS
 *     resolving a public name to RFC 1918 / metadata IPs.
 *   - `maxPayload: MAX_FRAME_BYTES` is set on the upstream WebSocket so the
 *     `ws` library refuses oversized frames at the receiver — without this,
 *     a hostile upstream can buffer multi-GB frames before our onMessage
 *     check fires and OOM the process.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { WSContext, WSEvents } from 'hono/ws';
import WebSocket from 'ws';
import type { Env } from '../env';
import { consumeTicket } from './ws-ticket';
import { validateWsUrl } from '@shared/protocol/websocket-proxy';
import { sanitizeRequestHeaders } from '@shared/protocol/header-policy';
import { allowPrivateIPs as readAllowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { assertNodeHostnameSafe, type NodeDnsGuardOptions } from '../shared/dns-guard-node';

const MAX_FRAME_BYTES = 1 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();

// Loose typing — @hono/node-ws's upgradeWebSocket return signature varies
// across versions; the only invariant we depend on is that it's a Hono
// handler/middleware Hono's router accepts at registration time.
type UpgradeWebSocketFactory = (
  createEvents: (c: Context<{ Bindings: Env }>) => WSEvents | Promise<WSEvents>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => MiddlewareHandler<any>;

function sizeOf(data: string | ArrayBufferLike | Uint8Array | Buffer): number {
  if (typeof data === 'string') {
    if (data.length * 4 <= MAX_FRAME_BYTES) return data.length;
    return TEXT_ENCODER.encode(data).byteLength;
  }
  if (data instanceof Uint8Array) return data.byteLength;
  return data.byteLength;
}

/** Normalise the `ws` library's `RawData` (Buffer | ArrayBuffer | Buffer[])
 *  into a single Buffer. Avoids the silent corruption if `binaryType` is
 *  switched to 'fragments' (which would otherwise stringify a Buffer[] via
 *  comma-join). */
function normaliseRawData(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

export function createNodeWebsocketHandler(
  upgradeWebSocket: UpgradeWebSocketFactory,
  dnsGuard: NodeDnsGuardOptions = {}
) {
  return upgradeWebSocket((c: Context<{ Bindings: Env }>): WSEvents => {
    // Snapshot the ticket query and the SSRF allow-list at upgrade-decision
    // time; do NOT consume the ticket yet. consumeTicket() is a destructive
    // one-shot read; running it here would burn the ticket on non-upgrade
    // probes too (`GET /api/ws?ticket=...` with no Upgrade header).
    const ticket = c.req.query('ticket');
    const allowLocalhost = isLocalDevBypass(c.env);
    const allowPrivateIPs = readAllowPrivateIPs(c.env);
    const perRequestDnsGuard: NodeDnsGuardOptions = {
      allowLocalhost: dnsGuard.allowLocalhost === true || allowLocalhost,
      allowPrivateIPs: dnsGuard.allowPrivateIPs === true || allowPrivateIPs,
    };

    let upstream: WebSocket | null = null;
    let serverWs: WSContext<unknown> | null = null;
    const queue: Array<string | Buffer> = [];

    const closeBoth = (code = 1000, reason = '') => {
      try {
        upstream?.close(code, reason);
      } catch {
        /* already closed */
      }
      try {
        serverWs?.close(code, reason);
      } catch {
        /* already closed */
      }
    };

    return {
      async onOpen(_ev, ws) {
        // Consume the ticket only after the upgrade has succeeded.
        const spec = ticket ? consumeTicket(ticket) : null;
        if (!spec) {
          ws.close(1008, 'Invalid or expired ticket');
          return;
        }
        const validation = validateWsUrl(spec.target, { allowLocalhost, allowPrivateIPs });
        if (!validation.ok) {
          ws.close(1008, `Invalid target: ${validation.error ?? 'validation failed'}`);
          return;
        }
        serverWs = ws;

        // DNS guard: resolve and reject private/metadata IPs before dialling.
        let upstreamHostname: string;
        try {
          upstreamHostname = new URL(spec.target).hostname;
        } catch {
          ws.close(1008, 'Invalid upstream URL');
          return;
        }
        try {
          await assertNodeHostnameSafe(upstreamHostname, perRequestDnsGuard);
        } catch (err) {
          ws.close(1008, `Upstream DNS guard failed: ${(err as Error).message}`);
          return;
        }

        const sanitisedHeaders = sanitizeRequestHeaders({
          ...(spec.headers ?? {}),
        });
        try {
          upstream = new WebSocket(spec.target, spec.protocols, {
            headers: sanitisedHeaders,
            // The validateWsUrl + DNS guard combo enforces SSRF policy.
            // Defer cert verification to the system trust store; enterprises
            // with internal CAs set NODE_EXTRA_CA_CERTS at process startup.
            // maxPayload bounds the receiver buffer BEFORE delivering a
            // 'message' to the size-check below — without it, the ws lib
            // buffers each entire frame (no client default cap) and an
            // attacker-controlled upstream can OOM the process.
            maxPayload: MAX_FRAME_BYTES,
          });
        } catch (err) {
          ws.close(1011, `Upstream connect failed: ${(err as Error).message}`);
          return;
        }

        upstream.on('open', () => {
          // Flush messages buffered while the upstream was still connecting.
          for (const msg of queue) upstream?.send(msg);
          queue.length = 0;
        });
        upstream.on('message', (data, isBinary) => {
          const buf = normaliseRawData(data);
          if (sizeOf(buf) > MAX_FRAME_BYTES) {
            closeBoth(1009, 'Frame too large');
            return;
          }
          try {
            if (!isBinary) {
              ws.send(buf.toString('utf-8'));
            } else {
              // Buffer → Uint8Array<ArrayBuffer> for Hono's WSContext typing.
              // .buffer of Node's Buffer can be SharedArrayBuffer; copy into
              // a fresh ArrayBuffer-backed view to satisfy the slot.
              const copy = new Uint8Array(buf.byteLength);
              copy.set(buf);
              ws.send(copy);
            }
          } catch {
            /* peer closed */
          }
        });
        upstream.on('close', (code, reason) => {
          try {
            ws.close(code || 1000, reason?.toString() ?? '');
          } catch {
            /* already closed */
          }
        });
        upstream.on('error', () => {
          closeBoth(1011, 'Upstream error');
        });
      },
      onMessage(ev, _ws) {
        const data = ev.data;
        if (sizeOf(data) > MAX_FRAME_BYTES) {
          closeBoth(1009, 'Frame too large');
          return;
        }
        const payload = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(payload);
        } else {
          queue.push(payload);
        }
      },
      onClose(ev, _ws) {
        try {
          upstream?.close(ev.code, ev.reason);
        } catch {
          /* already closed */
        }
      },
      onError(_ev, _ws) {
        closeBoth(1011, 'Client error');
      },
    };
  });
}
