import { decodeWsBinaryFrame, encodeWsBinaryFrame } from '@shared/protocol/ws-binary-codec';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain, type WebContents } from 'electron';
import WebSocket from 'ws';
import { EVENT_PREFIX, IPC } from '../../shared/channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  validateIpcInput,
  WsConnectSchema,
  WsDisconnectSchema,
  WsPingSchema,
  WsSendSchema,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import { getExecutionPolicy } from '../security/execution-policy';
import {
  assertPinnedFetchCanHonorPolicy,
  type PolicyTransportConfig,
  resolvePolicyTransport,
} from '../security/policy-transport';
import { createPinnedLookup, resolveSafeAddress } from '../security/safe-connect';
import {
  materializeWsHandshakeAuth,
  needsWsHandshakeMaterialization,
  type SecretRedactor,
} from '../security/ws-handshake-auth';

const log = createLogger('websocket');

export const wsRateLimiter = createKeyedRateLimiter(20, 60_000);

const MAX_CONCURRENT_WS_CONNECTIONS = 50;

interface ActiveWebSocket {
  ws: WebSocket;
  connectionId: string;
  url: string;
  createdAt: number;
  /** webContents ID of the renderer that opened this connection — used for targeted IPC emission */
  webContentsId: number;
  setExplicitlyClosed?: () => void;
  /** Outstanding client pings (#919), oldest first, for pong → RTT matching. */
  pendingPings: PendingPing[];
}

interface PendingPing {
  /** Application data actually sent on the wire (and echoed by the pong). */
  wire: string;
  /** What the user typed — surfaced to the renderer instead of the wire nonce. */
  payload: string;
  sentAt: number;
}

let pingNonceCounter = 0;

/**
 * An empty user payload would let any empty (e.g. unsolicited) pong satisfy
 * an outstanding ping and fake the RTT, so send a short unique nonce instead.
 * User-supplied payloads go out unchanged. Well under the 125-byte limit.
 */
function pingWirePayload(payload: string): string {
  if (payload) return payload;
  pingNonceCounter = (pingNonceCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `restura-ping-${pingNonceCounter}`;
}

/** Bounds the outstanding-ping table so a silent peer can't grow it forever. */
const MAX_PENDING_PINGS = 32;

/**
 * Match a pong to the oldest outstanding ping with the same application data
 * (RFC 6455 §5.5.3: a Pong echoes the Ping's payload). Returns the RTT in
 * whole ms, or undefined for an unsolicited pong.
 */
function takePong(entry: ActiveWebSocket, wire: string): { payload: string; rttMs?: number } {
  const idx = entry.pendingPings.findIndex((p) => p.wire === wire);
  const [match] = idx === -1 ? [] : entry.pendingPings.splice(idx, 1);
  return match
    ? { payload: match.payload, rttMs: Math.round(performance.now() - match.sentAt) }
    : { payload: wire };
}

// Shared connection bookkeeping. dispose() flags the connection as explicitly
// closed (so the ws 'close' handler suppresses the trailing close event) and
// hard-terminates the socket — used for same-id replace, renderer-destroyed
// cleanup, and disposeAll. Explicit ws:disconnect is handled separately with a
// graceful close(1000).
function disposeWebSocket(entry: ActiveWebSocket): void {
  entry.setExplicitlyClosed?.();
  try {
    entry.ws.terminate();
  } catch {
    /* ignore */
  }
}

const connections = new StreamRegistry<ActiveWebSocket>({
  prefixes: EVENT_PREFIX.ws,
  dispose: disposeWebSocket,
});

interface PendingWebSocketClaim {
  webContentsId: number;
  token: symbol;
  ownerEntry?: ActiveWebSocket;
  /**
   * Present only for connects that resolve opaque credentials main-side
   * (#878/#882): aborted when the claim is cancelled (ws:disconnect, renderer
   * destroyed, teardown) so in-flight keychain / vault work stops.
   */
  abort?: AbortController;
}

const pendingConnections = new Map<string, PendingWebSocketClaim>();

function reserveWebSocketClaim(
  connectionId: string,
  webContents: WebContents,
  cancellable = false
): PendingWebSocketClaim | undefined {
  const key = ownerScopedKey(connectionId, webContents.id);
  if (pendingConnections.has(key)) return undefined;

  const ownerEntry = connections.getForOwner(connectionId, webContents.id);

  const claim: PendingWebSocketClaim = {
    webContentsId: webContents.id,
    token: Symbol(connectionId),
    ownerEntry,
    ...(cancellable ? { abort: new AbortController() } : {}),
  };
  pendingConnections.set(key, claim);
  bindRendererCleanup(pendingConnections, webContents, (deadId) =>
    disposeByOwner(pendingConnections, deadId, (pending) => pending.abort?.abort())
  );
  return pendingConnections.get(key) === claim ? claim : undefined;
}

function isClaimLive(connectionId: string, claim: PendingWebSocketClaim): boolean {
  return (
    pendingConnections.get(ownerScopedKey(connectionId, claim.webContentsId))?.token === claim.token
  );
}

function releaseWebSocketClaim(connectionId: string, claim: PendingWebSocketClaim): void {
  const key = ownerScopedKey(connectionId, claim.webContentsId);
  if (pendingConnections.get(key)?.token === claim.token) {
    pendingConnections.delete(key);
  }
}

// Maximum message size (1MB)
const MAX_MESSAGE_SIZE = 1024 * 1024;

export function resolveWebsocketExecutionPolicy<T extends PolicyTransportConfig>(config: T) {
  return resolvePolicyTransport(config);
}

function applyWebSocketPolicyConfig(url: string) {
  const policyConfig = resolveWebsocketExecutionPolicy({ url });
  assertPinnedFetchCanHonorPolicy(policyConfig);
  return policyConfig;
}

export function registerWebSocketHandlerIPC(): void {
  // ws:connect is handled manually (not via createValidatedHandler) so we can capture
  // event.sender.id and target IPC emissions to the originating renderer window.
  ipcMain.handle(IPC.ws.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.ws.connect, event);
    const validated = validateIpcInput(WsConnectSchema, rawConfig, IPC.ws.connect);
    const connectionId = validated.connectionId;
    const webContentsId = event.sender.id;
    // GraphQL subscriptions (#878/#882) may carry SecretRef-handle auth and
    // SecretRef-backed {{vars}} that only main can resolve (ADR-0007).
    const materialize = needsWsHandshakeMaterialization(validated);

    // Cheap, local and secret-free: a policy rejection never burns a rate token.
    let policyConfig: ReturnType<typeof applyWebSocketPolicyConfig>;
    try {
      policyConfig = applyWebSocketPolicyConfig(validated.url);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Connection policy rejected',
      };
    }

    if (!wsRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    // Capacity check and reservation are synchronous together, so concurrent
    // connects (including ones about to await credential resolution) can't
    // overshoot the cap.
    if (connections.size() + pendingConnections.size >= MAX_CONCURRENT_WS_CONNECTIONS) {
      return { success: false, error: 'Too many open connections.' };
    }

    // Reserve this renderer's id synchronously before credential resolution, DNS
    // or transport construction. Another renderer may independently use the
    // same external id. Plain connects stay fully synchronous up to the DNS await.
    const claim = reserveWebSocketClaim(connectionId, event.sender, materialize);
    if (!claim) return { success: false, error: 'Not connected' };

    // Scrubs resolved plaintext from everything this connection sends back to
    // the renderer (replies, error/close events) and to logs.
    let redact: SecretRedactor = (text) => text;
    let config = validated;

    try {
      if (materialize) {
        // Resolved after the rate / capacity gates (no free keychain or vault
        // lookups) and BEFORE the SSRF check, which must see the final URL.
        // Cancelled by ws:disconnect / renderer teardown via the claim's signal.
        try {
          const materialized = await materializeWsHandshakeAuth(
            {
              url: validated.url,
              headers: validated.headers,
              auth: validated.auth,
              secretVariables: validated.secretVariables,
            },
            claim.abort?.signal
          );
          config = { ...validated, url: materialized.url, headers: materialized.headers };
          redact = materialized.redact;
        } catch (err) {
          if (!isClaimLive(connectionId, claim)) return { success: false, error: 'Not connected' };
          // Materializer errors are plaintext-free by construction.
          return {
            success: false,
            error: `WebSocket auth setup failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          };
        }
        if (!isClaimLive(connectionId, claim)) return { success: false, error: 'Not connected' };
        // Re-evaluate policy against the final (secret-resolved) URL.
        try {
          policyConfig = applyWebSocketPolicyConfig(config.url);
        } catch (err) {
          return {
            success: false,
            error: redact(err instanceof Error ? err.message : 'Connection policy rejected'),
          };
        }
      }

      // Resolve + validate once, then PIN the handshake to that IP via a Node
      // `lookup` hook (closes the DNS-rebind window pre-flight validation alone
      // leaves open). The URL keeps the original hostname so SNI + Host header
      // stay correct for TLS.
      let pinned: Awaited<ReturnType<typeof resolveSafeAddress>>;
      try {
        pinned = await resolveSafeAddress(config.url, {
          ...getExecutionPolicy().security,
          allowedSchemes: ['ws:', 'wss:'],
        });
      } catch (err) {
        return {
          success: false,
          error: redact(err instanceof Error ? err.message : 'URL rejected by SSRF policy'),
        };
      }

      // Renderer destruction/module teardown may invalidate the reservation
      // while DNS is pending. Never construct a transport for a stale claim.
      const key = ownerScopedKey(connectionId, webContentsId);
      if (pendingConnections.get(key)?.token !== claim.token) {
        return { success: false, error: 'Not connected' };
      }

      try {
        let explicitlyClosed = false;

        const ws = new WebSocket(config.url, config.protocols ?? [], {
          headers: config.headers ?? {},
          maxPayload: MAX_MESSAGE_SIZE,
          rejectUnauthorized: policyConfig.verifySsl,
          // Same-host handshake redirects are followed; a redirect to a DIFFERENT
          // host fails closed — `createPinnedLookup` errors on any hostname other
          // than the validated one (an attacker can't 3xx into an internal/metadata
          // target). Cross-host handshake redirects are rare and not supported by
          // design; the abort surfaces as a normal `ws` 'error' event below.
          // Never with main-side-resolved credentials: a same-host redirect may
          // downgrade wss→ws (or change path) and would replay keychain secrets.
          followRedirects: !materialize,
          handshakeTimeout: policyConfig.timeout,
          // #923: per-connection toggle; `ws` offers permessage-deflate by default.
          perMessageDeflate: config.perMessageDeflate ?? true,
          lookup: createPinnedLookup(pinned.host, pinned.ip),
        });

        // NOTE: success is returned immediately (handshake in progress).
        // The renderer should wait for the ws:open:<connectionId> event before sending messages.
        const entry: ActiveWebSocket = {
          ws,
          connectionId,
          url: config.url,
          createdAt: Date.now(),
          webContentsId,
          pendingPings: [],
        };

        // Full negotiated Sec-WebSocket-Extensions (with parameters) from the
        // 101 response; `ws.extensions` only carries the extension names.
        let negotiatedExtensions: string | undefined;
        ws.on('upgrade', (res: { headers: Record<string, string | string[] | undefined> }) => {
          const header = res.headers['sec-websocket-extensions'];
          negotiatedExtensions = Array.isArray(header) ? header.join(', ') : header;
        });

        ws.on('open', () => {
          if (connections.get(connectionId, webContentsId) !== entry) return;
          // Surface the negotiated subprotocol so the renderer can satisfy callers
          // that verify it (graphql-transport-ws requires socket.protocol to match).
          // #923: also surface the negotiated extensions (e.g. permessage-deflate).
          connections.emit(connectionId, webContentsId, 'open', {
            protocol: redact(ws.protocol ?? ''),
            extensions: redact(negotiatedExtensions ?? ws.extensions ?? ''),
          });
        });

        // #919: control frames. `ws` auto-answers server pings (autoPong).
        ws.on('ping', (data: Buffer) => {
          if (connections.get(connectionId, webContentsId) !== entry) return;
          connections.emit(connectionId, webContentsId, 'pingReceived', {
            data: redact(data.toString('utf8')),
          });
        });

        ws.on('pong', (data: Buffer) => {
          if (connections.get(connectionId, webContentsId) !== entry) return;
          const { payload, rttMs } = takePong(entry, data.toString('utf8'));
          connections.emit(connectionId, webContentsId, 'pong', {
            data: redact(payload),
            ...(rttMs !== undefined ? { rttMs } : {}),
          });
        });

        ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          if (connections.get(connectionId, webContentsId) !== entry) return;
          if (isBinary) {
            // Binary frames cross IPC as base64 (shared codec, same as the renderer)
            let buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
            if (materialize) {
              // Main-side-auth connection: scrub a server-reflected credential
              // (bytes untouched unless a secret is actually present).
              const text = buf.toString('utf8');
              const scrubbed = redact(text);
              if (scrubbed !== text) buf = Buffer.from(scrubbed, 'utf8');
            }
            connections.emit(connectionId, webContentsId, 'message', {
              type: 'binary',
              data: encodeWsBinaryFrame(buf),
            });
          } else {
            // A server reflecting a main-resolved credential (#882) must not
            // hand it to the renderer. Identity for plain connections.
            connections.emit(connectionId, webContentsId, 'message', {
              type: 'text',
              data: redact(data.toString()),
            });
          }
        });

        ws.on('error', (err: Error) => {
          const message = redact(err.message);
          log.warn('socket error', { connectionId, error: message });
          if (connections.get(connectionId, webContentsId) !== entry) return;
          connections.emit(connectionId, webContentsId, 'error', { message });
        });

        ws.on('close', (code: number, reason: Buffer) => {
          // Only forward unexpected closes; explicit ws:disconnect / teardown sets
          // explicitlyClosed. emitAndRemove keeps the emit-before-remove ordering.
          // Identity check: a same-id reconnect may have replaced this entry while
          // the old socket was still finishing its close handshake — don't remove
          // the successor.
          if (connections.get(connectionId, webContentsId) !== entry) return;
          if (!explicitlyClosed) {
            connections.emitAndRemove(connectionId, webContentsId, 'close', {
              code,
              reason: redact(reason.toString()),
            });
          } else {
            connections.remove(connectionId, webContentsId);
          }
        });

        entry.setExplicitlyClosed = () => {
          explicitlyClosed = true;
        };

        // Commit only the exact live reservation. For reconnects, also require
        // the original owner entry to still be current so stale work cannot
        // replace a newer connection.
        const claimed =
          pendingConnections.get(key)?.token === claim.token &&
          (claim.ownerEntry
            ? connections.get(connectionId, webContentsId) === claim.ownerEntry &&
              connections.replaceForOwner(connectionId, webContentsId, entry)
            : connections.tryAdd(connectionId, event.sender, entry));
        if (!claimed) {
          disposeWebSocket(entry);
          return { success: false, error: 'Not connected' };
        }

        return { success: true };
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : 'Failed to connect');
        log.warn('connect failed', { connectionId, error: message });
        return {
          success: false,
          error: message,
        };
      }
    } finally {
      releaseWebSocketClaim(connectionId, claim);
    }
  });

  ipcMain.handle(
    IPC.ws.send,
    createValidatedEventHandler(IPC.ws.send, WsSendSchema, async (config, event) => {
      const connectionId = config.connectionId;
      const entry = connections.getForOwner(connectionId, event.sender.id);

      if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
        return { success: false, error: 'Not connected' };
      }

      try {
        if (config.binary) {
          // Binary messages arrive from the renderer as base64 (shared codec);
          // a non-base64 payload throws here and is reported, never sent.
          entry.ws.send(decodeWsBinaryFrame(config.message));
        } else {
          entry.ws.send(config.message);
        }
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Send failed',
        };
      }
    })
  );

  ipcMain.handle(
    IPC.ws.ping,
    createValidatedEventHandler(IPC.ws.ping, WsPingSchema, async (config, event) => {
      const entry = connections.getForOwner(config.connectionId, event.sender.id);
      if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
        return { success: false, error: 'Not connected' };
      }
      const payload = config.payload ?? '';
      const wire = pingWirePayload(payload);
      try {
        entry.ws.ping(Buffer.from(wire, 'utf8'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Ping failed' };
      }
      entry.pendingPings.push({ wire, payload, sentAt: performance.now() });
      if (entry.pendingPings.length > MAX_PENDING_PINGS) entry.pendingPings.shift();
      return { success: true };
    })
  );

  ipcMain.handle(
    IPC.ws.disconnect,
    createValidatedEventHandler(IPC.ws.disconnect, WsDisconnectSchema, async (config, event) => {
      const connectionId = config.connectionId;
      // A connect still pending (resolving main-side credentials or DNS) is
      // cancelled outright — it must not open a socket after the renderer asked
      // to disconnect (#908). Dropping the claim makes its post-await liveness
      // check fail, so no transport is ever constructed.
      const pendingKey = ownerScopedKey(connectionId, event.sender.id);
      const pending = pendingConnections.get(pendingKey);
      if (pending) {
        pending.abort?.abort();
        pendingConnections.delete(pendingKey);
      }
      const entry = connections.getForOwner(connectionId, event.sender.id);
      if (entry) {
        // Graceful close for an explicit disconnect — distinct from the
        // hard terminate() that dispose() uses for teardown. The entry stays
        // tracked until the 'close' event removes it, so a peer that stalls the
        // close handshake is still visible to disposeAll/renderer-destroyed
        // teardown (ws's ~30s close timer bounds the wait).
        entry.setExplicitlyClosed?.();
        // #915: caller-chosen code/reason (validated per RFC 6455 by the schema).
        if (config.code !== undefined) entry.ws.close(config.code, config.reason ?? '');
        else entry.ws.close(1000, 'Client disconnected');
      }
      return { success: true };
    })
  );
}

export function stopWebSocketCleanup(): void {
  for (const pending of pendingConnections.values()) pending.abort?.abort();
  pendingConnections.clear();
  connections.disposeAll();
}
