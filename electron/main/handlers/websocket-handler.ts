import { createLogger } from '@shared/runtime/logger';
import { ipcMain, session, type WebContents } from 'electron';
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
  WsSendSchema,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import {
  createEnterpriseProxyAgent,
  resolveManagedProxyForUrl,
} from '../security/enterprise-network';
import { getExecutionPolicy } from '../security/execution-policy';
import { getManagedEnterprisePolicy } from '../security/managed-enterprise-policy';
import {
  assertPinnedFetchCanHonorPolicy,
  type PolicyTransportConfig,
  resolvePolicyTransport,
} from '../security/policy-transport';
import { createPinnedLookup, resolveSafeAddress } from '../security/safe-connect';
import { buildTlsClientMaterial } from '../security/tls-material';

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
}

const pendingConnections = new Map<string, PendingWebSocketClaim>();

function reserveWebSocketClaim(
  connectionId: string,
  webContents: WebContents
): PendingWebSocketClaim | undefined {
  const key = ownerScopedKey(connectionId, webContents.id);
  if (pendingConnections.has(key)) return undefined;

  const ownerEntry = connections.getForOwner(connectionId, webContents.id);

  const claim: PendingWebSocketClaim = {
    webContentsId: webContents.id,
    token: Symbol(connectionId),
    ownerEntry,
  };
  pendingConnections.set(key, claim);
  bindRendererCleanup(pendingConnections, webContents, (deadId) =>
    disposeByOwner(pendingConnections, deadId, () => {})
  );
  return pendingConnections.get(key) === claim ? claim : undefined;
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

function applyWebSocketPolicyConfig(url: string, proxy?: PolicyTransportConfig['proxy']) {
  const policyConfig = resolveWebsocketExecutionPolicy({ url, proxy });
  assertPinnedFetchCanHonorPolicy(policyConfig);
  return policyConfig;
}

export function registerWebSocketHandlerIPC(): void {
  // ws:connect is handled manually (not via createValidatedHandler) so we can capture
  // event.sender.id and target IPC emissions to the originating renderer window.
  ipcMain.handle(IPC.ws.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.ws.connect, event);
    const config = validateIpcInput(WsConnectSchema, rawConfig, IPC.ws.connect);
    const managedMode = getManagedEnterprisePolicy().status.state !== 'unmanaged';
    let policyConfig: ReturnType<typeof applyWebSocketPolicyConfig>;
    try {
      const managed = getManagedEnterprisePolicy();
      if (managed.status.state === 'unmanaged') {
        policyConfig = applyWebSocketPolicyConfig(config.url);
      } else {
        const proxy = await resolveManagedProxyForUrl(config.url, session.defaultSession, managed);
        policyConfig = applyWebSocketPolicyConfig(config.url, proxy);
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Connection policy rejected',
      };
    }
    const connectionId = config.connectionId;
    const webContentsId = event.sender.id;

    if (!wsRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    if (connections.size() + pendingConnections.size >= MAX_CONCURRENT_WS_CONNECTIONS) {
      return { success: false, error: 'Too many open connections.' };
    }

    // Reserve this renderer's id synchronously before DNS or transport
    // construction. Another renderer may independently use the same external id.
    const claim = reserveWebSocketClaim(connectionId, event.sender);
    if (!claim) return { success: false, error: 'Not connected' };

    try {
      // Resolve + validate once, then PIN the handshake to that IP via a Node
      // `lookup` hook (closes the DNS-rebind window pre-flight validation alone
      // leaves open). The URL keeps the original hostname so SNI + Host header
      // stay correct for TLS.
      let pinned: Awaited<ReturnType<typeof resolveSafeAddress>> | undefined;
      try {
        if (!policyConfig.proxy?.enabled) {
          pinned = await resolveSafeAddress(config.url, {
            ...getExecutionPolicy().security,
            allowedSchemes: ['ws:', 'wss:'],
          });
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'URL rejected by SSRF policy',
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
        const proxyAgent =
          policyConfig.proxy?.enabled &&
          (policyConfig.proxy.type === 'http' ||
            policyConfig.proxy.type === 'https' ||
            policyConfig.proxy.resolution)
            ? await createEnterpriseProxyAgent(
                policyConfig.proxy,
                policyConfig,
                getManagedEnterprisePolicy()
              )
            : undefined;

        const ws = new WebSocket(config.url, config.protocols ?? [], {
          headers: config.headers ?? {},
          maxPayload: MAX_MESSAGE_SIZE,
          rejectUnauthorized: policyConfig.verifySsl,
          // Same-host handshake redirects are followed; a redirect to a DIFFERENT
          // host fails closed — `createPinnedLookup` errors on any hostname other
          // than the validated one (an attacker can't 3xx into an internal/metadata
          // target). Cross-host handshake redirects are rare and not supported by
          // design; the abort surfaces as a normal `ws` 'error' event below.
          // A redirect can select a different PAC/bypass route. The ws client
          // accepts only one static agent, so managed mode fails closed instead
          // of silently reusing the initial destination's route.
          followRedirects: !managedMode,
          handshakeTimeout: policyConfig.timeout,
          ...(proxyAgent
            ? { agent: proxyAgent }
            : { lookup: createPinnedLookup(pinned!.host, pinned!.ip) }),
          ...buildTlsClientMaterial(policyConfig),
          ...(policyConfig.serverCipherOrder ? { honorCipherOrder: true } : {}),
          ...(policyConfig.minTlsVersion ? { minVersion: policyConfig.minTlsVersion } : {}),
          ...(policyConfig.cipherSuites ? { ciphers: policyConfig.cipherSuites } : {}),
        });

        // NOTE: success is returned immediately (handshake in progress).
        // The renderer should wait for the ws:open:<connectionId> event before sending messages.
        const entry: ActiveWebSocket = {
          ws,
          connectionId,
          url: config.url,
          createdAt: Date.now(),
          webContentsId,
        };

        ws.on('open', () => {
          if (connections.get(connectionId, webContentsId) !== entry) return;
          // Surface the negotiated subprotocol so the renderer can satisfy callers
          // that verify it (graphql-transport-ws requires socket.protocol to match).
          connections.emit(connectionId, webContentsId, 'open', { protocol: ws.protocol ?? '' });
        });

        ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          if (connections.get(connectionId, webContentsId) !== entry) return;
          if (isBinary) {
            // Binary frames are encoded as base64 for IPC transport
            const b64 = Buffer.isBuffer(data)
              ? data.toString('base64')
              : Buffer.from(data as ArrayBuffer).toString('base64');
            connections.emit(connectionId, webContentsId, 'message', {
              type: 'binary',
              data: b64,
            });
          } else {
            connections.emit(connectionId, webContentsId, 'message', {
              type: 'text',
              data: data.toString(),
            });
          }
        });

        ws.on('error', (err: Error) => {
          log.warn('socket error', { connectionId, error: err.message });
          if (connections.get(connectionId, webContentsId) !== entry) return;
          connections.emit(connectionId, webContentsId, 'error', { message: err.message });
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
              reason: reason.toString(),
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
        const message = err instanceof Error ? err.message : 'Failed to connect';
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
          // Binary messages arrive from renderer as base64 (matching the receive encoding)
          const buf = Buffer.from(config.message, 'base64');
          entry.ws.send(buf);
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
    IPC.ws.disconnect,
    createValidatedEventHandler(IPC.ws.disconnect, WsDisconnectSchema, async (config, event) => {
      const connectionId = config.connectionId;
      const entry = connections.getForOwner(connectionId, event.sender.id);
      if (entry) {
        // Graceful close (1000) for an explicit disconnect — distinct from the
        // hard terminate() that dispose() uses for teardown. The entry stays
        // tracked until the 'close' event removes it, so a peer that stalls the
        // close handshake is still visible to disposeAll/renderer-destroyed
        // teardown (ws's ~30s close timer bounds the wait).
        entry.setExplicitlyClosed?.();
        entry.ws.close(1000, 'Client disconnected');
      }
      return { success: true };
    })
  );
}

export function stopWebSocketCleanup(): void {
  pendingConnections.clear();
  connections.disposeAll();
}
