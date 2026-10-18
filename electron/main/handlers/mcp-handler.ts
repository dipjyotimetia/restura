import { isMcpOAuthFlow } from '@shared/protocol/mcp-auth';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain, type WebContents } from 'electron';
import { EVENT_PREFIX, eventChannel, IPC } from '../../shared/channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  McpCancelSchema,
  McpConnectSchema,
  McpDisconnectSchema,
  McpRequestSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import { getExecutionPolicy } from '../security/execution-policy';
import {
  materializeMcpConnectAuth,
  needsMcpConnectAuth,
  redactDeep,
} from '../security/mcp-connect-auth';
import { createMcpOAuthSession, registerMcpOAuthIPC } from '../security/mcp-oauth-connect';
import { isMcpOAuthReauthRequired, type McpOAuthSession } from '../security/mcp-oauth-provider';
import {
  assertPinnedFetchCanHonorPolicy,
  createPolicyPinnedFetch,
  type PolicyTransportConfig,
  resolvePolicyTransport,
} from '../security/policy-transport';
import { resolveSafeAddress } from '../security/safe-connect';
import {
  McpClientRequestBridge,
  registerMcpClientRequestIPC,
  stopMcpClientRequests,
} from './mcp-client-requests';
import { connectMcpSdkClient, type McpSdkClient } from './mcp-sdk-client';

const log = createLogger('mcp');

/**
 * MCP IPC handler, backed by the official v2 MCP client. The SDK owns JSON-RPC framing, its
 * initialize/discover handshake, session tracking, and SSE demuxing:
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

interface McpSession {
  connectionId: string;
  url: string;
  webContentsId: number;
  createdAt: number;
  client?: McpSdkClient;
  /** Server→client requests (elicitation / sampling / roots) for this session. */
  clientRequests?: McpClientRequestBridge;
  /** Scrubs main-resolved auth plaintext (#896) from text sent to the renderer. */
  redact: (text: string) => string;
  /** Deep variant of `redact` for server-controlled JSON (results, error data, notifications). */
  scrub: <T>(value: T) => T;
  /** MCP OAuth 2.1 session (#856) — tokens live here, in main only. */
  oauth?: McpOAuthSession;
  /** Set before an intentional close so onclose/onerror don't emit events. */
  disposed: boolean;
  /** In-flight requests by renderer `requestId`, so `mcp:cancel` can abort them. */
  inflight: Map<string, AbortController>;
}

function disposeSession(s: McpSession): void {
  if (s.disposed) return;
  s.disposed = true;
  s.clientRequests?.dispose();
  s.oauth?.dispose();
  for (const controller of s.inflight.values()) controller.abort();
  s.inflight.clear();
  // Best-effort DELETE so well-behaved streamable-HTTP servers can free the session.
  void s.client?.terminateSession().catch(() => {});
  // close() also closes the selected client transport.
  void s.client?.close().catch(() => {});
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

/**
 * Connect deadline that pauses while the user is signing in in the system
 * browser (#856) — the loopback receiver enforces its own, longer timeout.
 */
function createConnectDeadline(timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: ((err: Error) => void) | undefined;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(
      () => fail?.(new Error(`Connection timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
  };
  return {
    promise: new Promise<never>((_resolve, reject) => {
      fail = reject;
      arm();
    }),
    pause: (waiting: boolean) => {
      if (!waiting) return arm();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function registerMcpHandlerIPC(): void {
  registerMcpClientRequestIPC();
  registerMcpOAuthIPC();
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
    // Scrubs main-resolved credential plaintext from everything this
    // connection sends back to the renderer (replies, error events) and logs.
    let redact = (text: string) => text;
    let headers = config.headers ?? {};
    let hasResolvedSecrets = false;

    try {
      // SSRF guard: resolve once, validate every record, and pin the connection
      // to the validated IP (closes the TTL=0 DNS-rebind window). MCP is
      // desktop-only; permit localhost (developers commonly run MCP servers
      // locally). SNI/Host stay on the original hostname.
      let pinnedFetch: typeof globalThis.fetch;
      let pinnedIp: string;
      try {
        const pinned = await resolveSafeAddress(policyConfig.url, {
          ...getExecutionPolicy().security,
        });
        pinnedIp = pinned.ip;
        pinnedFetch = createPolicyPinnedFetch(policyConfig, pinned);
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }

      // Renderer destruction/module teardown may invalidate the reservation
      // while DNS is pending. Never construct a transport for a stale claim.
      if (pendingSessions.get(key)?.token !== claim.token) {
        return { success: false, error: 'Not connected' };
      }

      // #896: resolve SecretRef-handle / external auth here (ADR-0007) — after
      // the rate / capacity gates AND the SSRF guard, so a blocked URL never
      // triggers a keychain or vault lookup. Header only: the URL pinned above
      // is never changed.
      const deadline = createConnectDeadline(policyConfig.timeout);
      deadline.promise.catch(() => undefined);
      let oauth: McpOAuthSession | undefined;
      if (isMcpOAuthFlow(config.auth)) {
        // #856: interactive OAuth 2.1 — tokens are acquired, stored and
        // refreshed in main; nothing token-shaped is ever sent back.
        try {
          oauth = createMcpOAuthSession(
            policyConfig.url,
            config.auth ?? {},
            { onAuthorizationWait: deadline.pause },
            pinnedIp
          );
        } catch (err) {
          deadline.clear();
          return { success: false, error: `MCP auth setup failed: ${errorMessage(err)}` };
        }
        redact = oauth.redact;
        hasResolvedSecrets = true;
      } else if (needsMcpConnectAuth(config)) {
        try {
          const materialized = await materializeMcpConnectAuth({
            url: policyConfig.url,
            headers,
            auth: config.auth,
          });
          headers = materialized.headers;
          redact = materialized.redact;
          hasResolvedSecrets = true;
        } catch (err) {
          deadline.clear();
          // Materializer errors are plaintext-free by construction.
          return { success: false, error: `MCP auth setup failed: ${errorMessage(err)}` };
        }
        if (pendingSessions.get(key)?.token !== claim.token) {
          deadline.clear();
          return { success: false, error: 'Not connected' };
        }
      }
      // Server-controlled payloads (results, error data, notifications) may
      // echo the resolved credential — scrub them before they reach the renderer.
      const scrub = <T>(value: T): T => (hasResolvedSecrets ? redactDeep(value, redact) : value);

      // User headers ride as the transport's base `requestInit`; the SDK applies
      // them to every request (the GET SSE stream included) and sets its own
      // protocol headers (Accept, Content-Type) after the merge, so they win.
      const transportOptions = {
        fetch: pinnedFetch as (url: string | URL, init?: RequestInit) => Promise<Response>,
        requestInit: { headers },
        ...(oauth ? { authProvider: oauth.authProvider } : {}),
      };
      const session: McpSession = {
        connectionId: config.connectionId,
        url: policyConfig.url,
        webContentsId,
        createdAt: Date.now(),
        redact,
        scrub,
        ...(oauth ? { oauth } : {}),
        disposed: false,
        clientRequests: new McpClientRequestBridge(config.connectionId, webContentsId),
        inflight: new Map(),
      };

      const events = {
        onNotification: async (notification: unknown) => {
          if (session.disposed) return;
          emitTo(
            webContentsId,
            eventChannel(EVENT_PREFIX.mcp.notification, config.connectionId),
            scrub(notification)
          );
        },
        onError: (err: Error) => {
          if (session.disposed) return;
          const message = redact(errorMessage(err));
          log.warn('client error', { connectionId: config.connectionId, error: message });
          emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.error, config.connectionId), {
            message,
          });
        },
        onClose: () => {
          if (session.disposed) return;
          session.disposed = true;
          session.clientRequests?.dispose();
          if (sessions.get(config.connectionId, webContentsId) === session) {
            sessions.remove(config.connectionId, webContentsId);
            emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.close, config.connectionId), {
              reason: 'stream ended',
            });
          }
        },
      };

      if (pendingSessions.get(key)?.token !== claim.token) {
        deadline.clear();
        disposeSession(session);
        return { success: false, error: 'Not connected' };
      }
      claim.pendingSession = session;

      try {
        // v2 probes for modern protocol support and falls back internally to
        // the legacy initialize handshake when the peer is 2025-era.
        try {
          await Promise.race([
            connectMcpSdkClient({
              url: new URL(policyConfig.url),
              transport: config.transport,
              transportOptions,
              events,
              ...(session.clientRequests ? { clientRequests: session.clientRequests } : {}),
              onClientCreated: (client) => {
                session.client = client;
                session.clientRequests?.attachClient(client);
              },
            }).then(async (client) => {
              session.client = client;
              // Sign in now if `initialize` got through without a token.
              await oauth?.ensureSignedIn();
            }),
            deadline.promise,
          ]);
        } finally {
          deadline.clear();
        }
        // A lapsed OAuth session now prompts the renderer instead of popping a browser.
        oauth?.endInteractive();
        // Guard the connect-time race: if onclose/onerror fired DURING the
        // handshake, `session.disposed` is already true but the session was not in
        // the registry yet, so onclose's `sessions.get(...) === session` guard
        // skipped its close emit. Adding it now + emitting `mcp:open` would tell
        // the renderer a dead connection is live (every later request fails, with
        // no close ever sent). Treat it as a failed connect instead.
        if (session.disposed) {
          if (pendingSessions.get(key)?.token === claim.token) {
            void session.client?.close().catch(() => {});
          }
          oauth?.dispose();
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
          session.clientRequests?.dispose();
          void session.client?.close().catch(() => {});
        }
        oauth?.dispose();
        const message = redact(errorMessage(err));
        log.warn('connect failed', { connectionId: config.connectionId, error: message });
        return {
          success: false,
          error: message,
          ...(oauth && (oauth.reauthRequired || isMcpOAuthReauthRequired(err))
            ? { authRequired: true }
            : {}),
        };
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
        if (!session?.client) {
          return { success: false, error: 'Not connected' };
        }
        const timeoutMs = config.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
        const controller = new AbortController();

        try {
          // The SDK already ran initialize during connect; forwarding another
          // would be a protocol violation. Synthesize the result the renderer's
          // discovery flow expects from the negotiated state.
          if (config.method === 'initialize') {
            const protocolVersion = session.client.getProtocolVersion();
            return {
              success: true,
              result: session.scrub({
                protocolVersion,
                capabilities: session.client.getServerCapabilities() ?? {},
                serverInfo: session.client.getServerVersion(),
              }),
            };
          }

          if (config.method.startsWith('notifications/')) {
            await session.client.notification(config.method, config.params);
            return { success: true, result: undefined };
          }

          // The v2 client owns request schemas and JSON-RPC ids; the renderer
          // only receives the normalized result.
          // A renderer-supplied requestId makes the call cancellable via `mcp:cancel`.
          // Aborting the signal makes the SDK send `notifications/cancelled` and
          // drop any late response.
          const cancelKey = config.requestId === undefined ? undefined : String(config.requestId);
          if (cancelKey !== undefined) {
            if (session.inflight.has(cancelKey)) {
              return { success: false, error: 'Duplicate in-flight requestId' };
            }
            session.inflight.set(cancelKey, controller);
          }
          try {
            const result = await session.client.request(
              config.method,
              config.params,
              timeoutMs,
              controller.signal
            );
            if (controller.signal.aborted) return { success: false, cancelled: true };
            return { success: true, result: session.scrub(result) };
          } finally {
            if (cancelKey !== undefined && session.inflight.get(cancelKey) === controller) {
              session.inflight.delete(cancelKey);
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return { success: false, cancelled: true };
          if (
            err &&
            typeof err === 'object' &&
            typeof (err as { code?: unknown }).code === 'number' &&
            typeof (err as { message?: unknown }).message === 'string'
          ) {
            const typed = err as { code: number; message: string; data?: unknown };
            return {
              success: false,
              jsonRpcError: {
                code: typed.code,
                message: session.redact(typed.message),
                data: session.scrub(typed.data),
              },
            };
          }
          // #856: a refresh failed mid-session — tell the renderer to prompt
          // for a fresh sign-in (reconnect) rather than retrying blindly.
          const authRequired =
            session.oauth !== undefined &&
            (session.oauth.reauthRequired || isMcpOAuthReauthRequired(err));
          return {
            success: false,
            error: session.redact(errorMessage(err)),
            ...(authRequired ? { authRequired: true } : {}),
          };
        }
      })
    )
  );

  ipcMain.handle(
    IPC.mcp.cancel,
    rateLimited(
      mcpRateLimiter,
      createValidatedEventHandler(IPC.mcp.cancel, McpCancelSchema, async (config, event) => {
        // Missing, already-finished, and wrong-owner ids are indistinguishable.
        const controller = sessions
          .getForOwner(config.connectionId, event.sender.id)
          ?.inflight.get(String(config.requestId));
        if (!controller) return { success: false };
        controller.abort();
        return { success: true };
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
  stopMcpClientRequests();
}
