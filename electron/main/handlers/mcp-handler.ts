import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  type ClientNotification,
  type ClientRequest,
  LATEST_PROTOCOL_VERSION,
  McpError,
  ResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain, type WebContents } from 'electron';
import { EVENT_PREFIX, eventChannel, IPC } from '../../shared/channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  McpConnectSchema,
  McpDisconnectSchema,
  McpRequestSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import { getExecutionPolicy } from '../security/execution-policy';
import {
  assertPinnedFetchCanHonorPolicy,
  createPolicyPinnedFetch,
  type PolicyTransportConfig,
  resolvePolicyTransport,
} from '../security/policy-transport';
import { resolveSafeAddress } from '../security/safe-connect';

const log = createLogger('mcp');

/**
 * MCP IPC handler, backed by the official `@modelcontextprotocol/sdk` client.
 * The SDK owns the wire protocol — JSON-RPC framing, the initialize handshake,
 * `Mcp-Session-Id` tracking, and SSE demuxing — for both HTTP transports:
 *
 * - **streamable-http**: `StreamableHTTPClientTransport` (single endpoint;
 *   POSTs for requests, optional GET SSE stream for server pushes).
 * - **http-sse** (legacy): `SSEClientTransport` (persistent SSE stream +
 *   separate POST endpoint advertised via the `endpoint` event).
 *
 * This module keeps the Restura-side concerns: IPC validation, rate limiting,
 * the SSRF guard (DNS-resolved-and-pinned fetch via `safe-connect`), and
 * renderer lifecycle cleanup.
 */

export const mcpRateLimiter = createKeyedRateLimiter(60, 60_000);
const MAX_CONCURRENT_MCP = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Apply acknowledged desktop defaults before establishing an MCP session. */
export function resolveMcpExecutionPolicy<T extends PolicyTransportConfig>(config: T) {
  return resolvePolicyTransport(config);
}

// Matches the clientInfo the renderer historically sent in its initialize call.
const CLIENT_INFO = { name: 'restura', version: '1.0.0' };

interface McpSession {
  connectionId: string;
  url: string;
  webContentsId: number;
  createdAt: number;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  /** Set before an intentional close so onclose/onerror don't emit events. */
  disposed: boolean;
}

function disposeSession(s: McpSession): void {
  if (s.disposed) return;
  s.disposed = true;
  if (s.transport instanceof StreamableHTTPClientTransport) {
    // Best-effort DELETE so well-behaved servers can free the session.
    void s.transport.terminateSession().catch(() => {});
  }
  // client.close() also closes the transport.
  void s.client.close().catch(() => {});
}

// Shared connection bookkeeping. MCP keeps direct `emitTo` for its events (a
// notification/onclose/onerror can fire before the session is added to the
// registry — i.e. during connect), so the registry is used only for the map,
// same-id replace, renderer-destroyed cleanup, and disposeAll. dispose() runs
// disposeSession (DELETE the session + close the client/transport).
const sessions = new StreamRegistry<McpSession>({ dispose: disposeSession });

interface PendingMcpClaim {
  webContentsId: number;
  token: symbol;
  ownerEntry?: McpSession;
  pendingSession?: McpSession;
}

const pendingSessions = new Map<string, PendingMcpClaim>();

function disposePendingMcpClaim(claim: PendingMcpClaim): void {
  if (!claim.pendingSession) return;
  disposeSession(claim.pendingSession);
  claim.pendingSession = undefined;
}

function reserveMcpClaim(
  connectionId: string,
  webContents: WebContents
): PendingMcpClaim | undefined {
  const key = ownerScopedKey(connectionId, webContents.id);
  if (pendingSessions.has(key)) return undefined;

  const ownerEntry = sessions.getForOwner(connectionId, webContents.id);

  const claim: PendingMcpClaim = {
    webContentsId: webContents.id,
    token: Symbol(connectionId),
    ownerEntry,
  };
  pendingSessions.set(key, claim);
  bindRendererCleanup(pendingSessions, webContents, (deadId) =>
    disposeByOwner(pendingSessions, deadId, disposePendingMcpClaim)
  );
  return pendingSessions.get(key) === claim ? claim : undefined;
}

function releaseMcpClaim(connectionId: string, claim: PendingMcpClaim): void {
  const key = ownerScopedKey(connectionId, claim.webContentsId);
  if (pendingSessions.get(key)?.token === claim.token) {
    pendingSessions.delete(key);
  }
}

function cancelPendingMcpClaimForOwner(connectionId: string, webContentsId: number): boolean {
  const key = ownerScopedKey(connectionId, webContentsId);
  const claim = pendingSessions.get(key);
  if (!claim) return false;

  // Invalidate the claim before closing its in-flight transport. If the close
  // settles connect synchronously, the stale attempt still cannot commit.
  pendingSessions.delete(key);
  try {
    disposePendingMcpClaim(claim);
  } catch {
    // Match StreamRegistry cancellation: teardown is best-effort and idempotent.
  }
  return true;
}

export function registerMcpHandlerIPC(): void {
  ipcMain.handle(IPC.mcp.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.mcp.connect, event);
    const config = validateIpcInput(McpConnectSchema, rawConfig, IPC.mcp.connect);
    const webContentsId = event.sender.id;

    let policyConfig: ReturnType<typeof resolveMcpExecutionPolicy>;
    try {
      policyConfig = resolveMcpExecutionPolicy(config);
      assertPinnedFetchCanHonorPolicy(policyConfig);
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }

    if (!mcpRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded.' };
    }
    if (sessions.size() + pendingSessions.size >= MAX_CONCURRENT_MCP) {
      return { success: false, error: 'Too many open MCP connections.' };
    }

    // Reserve this renderer's id synchronously before DNS or client construction.
    // Another renderer may independently use the same external id.
    const claim = reserveMcpClaim(config.connectionId, event.sender);
    if (!claim) return { success: false, error: 'Not connected' };
    const key = ownerScopedKey(config.connectionId, webContentsId);

    try {
      // SSRF guard: resolve once, validate every record, and pin the connection
      // to the validated IP (closes the TTL=0 DNS-rebind window). MCP is
      // desktop-only; permit localhost (developers commonly run MCP servers
      // locally). SNI/Host stay on the original hostname.
      let pinnedFetch: typeof globalThis.fetch;
      try {
        const pinned = await resolveSafeAddress(policyConfig.url, {
          ...getExecutionPolicy().security,
        });
        pinnedFetch = createPolicyPinnedFetch(policyConfig, pinned);
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }

      // Renderer destruction/module teardown may invalidate the reservation
      // while DNS is pending. Never construct a transport for a stale claim.
      if (pendingSessions.get(key)?.token !== claim.token) {
        return { success: false, error: 'Not connected' };
      }

      // User headers ride as the transport's base `requestInit`; the SDK applies
      // them to every request (the GET SSE stream included) and sets its own
      // protocol headers (Accept, Content-Type) after the merge, so they win.
      const transportOptions = {
        fetch: pinnedFetch as (url: string | URL, init?: RequestInit) => Promise<Response>,
        requestInit: { headers: config.headers ?? {} },
      };
      const url = new URL(policyConfig.url);
      const transport =
        config.transport === 'streamable-http'
          ? new StreamableHTTPClientTransport(url, transportOptions)
          : new SSEClientTransport(url, transportOptions);

      const client = new Client(CLIENT_INFO, { capabilities: {} });
      const session: McpSession = {
        connectionId: config.connectionId,
        url: policyConfig.url,
        webContentsId,
        createdAt: Date.now(),
        client,
        transport,
        disposed: false,
      };

      // Handlers go on the Client — Protocol.connect() overwrites the
      // transport's own onclose/onerror.
      client.fallbackNotificationHandler = async (notification) => {
        if (session.disposed) return;
        emitTo(
          webContentsId,
          eventChannel(EVENT_PREFIX.mcp.notification, config.connectionId),
          notification
        );
      };
      client.onerror = (err) => {
        if (session.disposed) return;
        const message = errorMessage(err);
        log.warn('client error', { connectionId: config.connectionId, error: message });
        emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.error, config.connectionId), {
          message,
        });
      };
      client.onclose = () => {
        if (session.disposed) return;
        session.disposed = true;
        if (sessions.get(config.connectionId, webContentsId) === session) {
          sessions.remove(config.connectionId, webContentsId);
          emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.close, config.connectionId), {
            reason: 'stream ended',
          });
        }
      };

      if (pendingSessions.get(key)?.token !== claim.token) {
        disposeSession(session);
        return { success: false, error: 'Not connected' };
      }
      claim.pendingSession = session;

      try {
        // Performs the full initialize handshake (and, for streamable-http,
        // opens the optional standalone SSE stream). Auth/connectivity errors
        // surface here rather than on the first request.
        let connectTimeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            client.connect(transport),
            new Promise<never>((_resolve, reject) => {
              connectTimeoutId = setTimeout(
                () => reject(new Error(`Connection timeout after ${policyConfig.timeout}ms`)),
                policyConfig.timeout
              );
            }),
          ]);
        } finally {
          if (connectTimeoutId !== undefined) clearTimeout(connectTimeoutId);
        }
        // Guard the connect-time race: if onclose/onerror fired DURING the
        // handshake, `session.disposed` is already true but the session was not in
        // the registry yet, so onclose's `sessions.get(...) === session` guard
        // skipped its close emit. Adding it now + emitting `mcp:open` would tell
        // the renderer a dead connection is live (every later request fails, with
        // no close ever sent). Treat it as a failed connect instead.
        if (session.disposed) {
          if (pendingSessions.get(key)?.token === claim.token) {
            void client.close().catch(() => {});
          }
          log.warn('connect closed during initialization', {
            connectionId: config.connectionId,
          });
          return { success: false, error: 'Connection closed during initialization' };
        }

        // Commit only the exact live reservation. A reconnect may replace only
        // the same renderer's still-current session.
        const claimed =
          pendingSessions.get(key)?.token === claim.token &&
          (claim.ownerEntry
            ? sessions.get(config.connectionId, webContentsId) === claim.ownerEntry &&
              sessions.replaceForOwner(config.connectionId, webContentsId, session)
            : sessions.tryAdd(config.connectionId, event.sender, session));
        if (!claimed) {
          disposeSession(session);
          return { success: false, error: 'Not connected' };
        }
        emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.open, config.connectionId));
        return { success: true };
      } catch (err) {
        if (!session.disposed) {
          session.disposed = true;
          void client.close().catch(() => {});
        }
        const message = errorMessage(err);
        log.warn('connect failed', { connectionId: config.connectionId, error: message });
        return { success: false, error: message };
      }
    } finally {
      releaseMcpClaim(config.connectionId, claim);
    }
  });

  ipcMain.handle(
    IPC.mcp.request,
    rateLimited(
      mcpRateLimiter,
      createValidatedEventHandler(IPC.mcp.request, McpRequestSchema, async (config, event) => {
        const session = sessions.getForOwner(config.connectionId, event.sender.id);
        if (!session) {
          return { success: false, error: 'Not connected' };
        }
        const timeoutMs = config.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;

        try {
          // The SDK already ran initialize during connect; forwarding another
          // would be a protocol violation. Synthesize the result the renderer's
          // discovery flow expects from the negotiated state.
          if (config.method === 'initialize') {
            const protocolVersion =
              session.transport instanceof StreamableHTTPClientTransport
                ? (session.transport.protocolVersion ?? LATEST_PROTOCOL_VERSION)
                : LATEST_PROTOCOL_VERSION;
            return {
              success: true,
              result: {
                protocolVersion,
                capabilities: session.client.getServerCapabilities() ?? {},
                serverInfo: session.client.getServerVersion(),
              },
            };
          }

          if (config.method.startsWith('notifications/')) {
            await session.client.notification({
              method: config.method,
              params: config.params,
            } as ClientNotification);
            return { success: true, result: undefined };
          }

          // ResultSchema is the spec's passthrough result shape — arbitrary
          // renderer-chosen methods forward without a method-specific schema.
          // The renderer's requestId is ignored: the SDK owns JSON-RPC ids.
          const result = await session.client.request(
            { method: config.method, params: config.params } as ClientRequest,
            ResultSchema,
            { timeout: timeoutMs }
          );
          return { success: true, result };
        } catch (err) {
          if (err instanceof McpError) {
            return {
              success: false,
              jsonRpcError: { code: err.code, message: err.message, data: err.data },
            };
          }
          return { success: false, error: errorMessage(err) };
        }
      })
    )
  );

  ipcMain.handle(
    IPC.mcp.disconnect,
    createValidatedEventHandler(IPC.mcp.disconnect, McpDisconnectSchema, async (config, event) => {
      // Missing and wrong-owner ids are deliberately indistinguishable.
      cancelPendingMcpClaimForOwner(config.connectionId, event.sender.id);
      sessions.cancelForOwner(config.connectionId, event.sender.id);
      return { success: true };
    })
  );
}

export function stopMcpCleanup(): void {
  for (const claim of pendingSessions.values()) {
    disposePendingMcpClaim(claim);
  }
  pendingSessions.clear();
  sessions.disposeAll();
}
