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
 *     `new WebSocket(...)` call, and the dial is pinned to the address it
 *     validated. Defends against attacker-controlled DNS resolving a public
 *     name to RFC 1918 / metadata IPs, including a rebind between the two.
 *   - `maxPayload: MAX_FRAME_BYTES` is set on the upstream WebSocket so the
 *     `ws` library refuses oversized frames at the receiver — without this,
 *     a hostile upstream can buffer multi-GB frames before our onMessage
 *     check fires and OOM the process.
 */

import { Buffer } from 'node:buffer';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { sanitizeRequestHeaders } from '@shared/protocol/header-policy';
import { validateWsUrl } from '@shared/protocol/websocket-proxy';
import type { Context, MiddlewareHandler } from 'hono';
import type { WSContext, WSEvents } from 'hono/ws';
import WebSocket from 'ws';
import type { Env } from '../env';
import { assertNodeHostnameSafe, type NodeDnsGuardOptions } from '../shared/dns-guard-node';
import { isLocalDevBypass, allowPrivateIPs as readAllowPrivateIPs } from '../shared/env';
import { closeReason, errorText, relayCloseCode } from '../shared/ws-relay';
import { consumeTicket } from './ws-ticket';

const MAX_FRAME_BYTES = 1 * 1024 * 1024;
/** Cap on client frames buffered before the upstream is open (DNS check + dial). */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();

// Loose typing — @hono/node-ws's upgradeWebSocket return signature varies
// across versions; the only invariant we depend on is that it's a Hono
// handler/middleware Hono's router accepts at registration time.
type UpgradeWebSocketFactory = (
  createEvents: (c: Context<{ Bindings: Env }>) => WSEvents | Promise<WSEvents>
  // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
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

/**
 * A `net`/`http` lookup that answers `host` with the one validated address and
 * refuses any other name (the relay never follows redirects; fail closed).
 */
function pinnedLookup(host: string, pinned: LookupAddress): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname !== host) {
      callback(new Error(`pinned lookup refused unexpected hostname "${hostname}"`), '', 4);
      return;
    }
    if (options.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
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
    // Set once either side is closing; checked after every await in onOpen so
    // a client that left during the DNS check never gets an upstream dialled.
    let closed = false;
    const queue: Array<string | Buffer> = [];
    let queuedBytes = 0;

    const closeUpstream = (code: number, reason: string) => {
      if (!upstream) return;
      try {
        upstream.close(relayCloseCode(code), closeReason(reason));
      } catch {
        upstream.terminate();
      }
    };
    const closeClient = (code: number, reason: string) => {
      if (!serverWs) return;
      try {
        serverWs.close(relayCloseCode(code), closeReason(reason));
      } catch {
        const raw = serverWs.raw;
        if (raw instanceof WebSocket) raw.terminate();
      }
    };
    const closeBoth = (code = 1000, reason = '') => {
      closed = true;
      closeUpstream(code, reason);
      closeClient(code, reason);
    };

    const openUpstream = async (ws: WSContext<unknown>): Promise<void> => {
      // Consume the ticket only after the upgrade has succeeded.
      const spec = ticket ? consumeTicket(ticket) : null;
      if (!spec) {
        closeBoth(1008, 'Invalid or expired ticket');
        return;
      }
      const validation = validateWsUrl(spec.target, { allowLocalhost, allowPrivateIPs });
      if (!validation.ok) {
        closeBoth(1008, `Invalid target: ${validation.error ?? 'validation failed'}`);
        return;
      }

      // DNS guard: resolve and reject private/metadata IPs before dialling.
      let upstreamHostname: string;
      try {
        upstreamHostname = new URL(spec.target).hostname;
      } catch {
        closeBoth(1008, 'Invalid upstream URL');
        return;
      }
      let pinned: LookupAddress | undefined;
      try {
        [pinned] = await assertNodeHostnameSafe(upstreamHostname, perRequestDnsGuard);
      } catch (err) {
        closeBoth(1008, `Upstream DNS guard failed: ${errorText(err)}`);
        return;
      }
      if (closed) return;
      if (!pinned) {
        closeBoth(1008, `Upstream DNS guard failed: no address for ${upstreamHostname}`);
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
          // Dial the address the guard validated: a second resolution here
          // would reopen the DNS-rebinding window. Host/SNI keep the name.
          lookup: pinnedLookup(upstreamHostname, pinned),
        });
      } catch (err) {
        closeBoth(1011, `Upstream connect failed: ${errorText(err)}`);
        return;
      }

      upstream.on('open', () => {
        // Flush messages buffered while the upstream was still connecting.
        for (const msg of queue) upstream?.send(msg);
        queue.length = 0;
        queuedBytes = 0;
      });
      upstream.on('message', (data, isBinary) => {
        const buf = normaliseRawData(data);
        if (sizeOf(buf) > MAX_FRAME_BYTES) {
          closeBoth(1009, 'Frame too large');
          return;
        }
        try {
          if (!isBinary) {
            ws.send(Buffer.from(buf).toString('utf-8'));
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
        closed = true;
        closeClient(code, reason.toString());
      });
      upstream.on('error', () => {
        closeBoth(1011, 'Upstream error');
      });
    };

    return {
      async onOpen(_ev, ws) {
        serverWs = ws;
        // @hono/node-ws does not await onOpen: a rejection here would be an
        // unhandled rejection, which terminates a Node 24 process.
        try {
          await openUpstream(ws);
        } catch {
          closeBoth(1011, 'Internal error');
        }
      },
      onMessage(ev, _ws) {
        if (closed) return;
        const data = ev.data;
        if (sizeOf(data) > MAX_FRAME_BYTES) {
          closeBoth(1009, 'Frame too large');
          return;
        }
        const payload = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(payload);
          return;
        }
        // Not dialled / still connecting: buffer, but never without bound.
        queuedBytes +=
          typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
        if (queuedBytes > MAX_QUEUED_BYTES) {
          queue.length = 0;
          closeBoth(1013, 'Upstream not ready');
          return;
        }
        queue.push(payload);
      },
      onClose(ev, _ws) {
        closed = true;
        closeUpstream(ev.code, ev.reason);
      },
      onError(_ev, _ws) {
        closeBoth(1011, 'Client error');
      },
    };
  });
}
