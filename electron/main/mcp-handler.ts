import { ipcMain } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  McpError,
  ResultSchema,
  LATEST_PROTOCOL_VERSION,
  type ClientRequest,
  type ClientNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { createKeyedRateLimiter, rateLimited } from './ipc-rate-limiter';
import { emitTo, errorMessage } from './ipc-utils';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { resolveSafeAddress, createPinnedFetch } from './safe-connect';
import {
  McpConnectSchema,
  McpRequestSchema,
  McpDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
  assertTrustedSender,
} from './ipc-validators';
import { IPC, EVENT_PREFIX, eventChannel } from '../shared/channels';

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

const sessions = new Map<string, McpSession>();

function disposeSession(s: McpSession): void {
  s.disposed = true;
  if (s.transport instanceof StreamableHTTPClientTransport) {
    // Best-effort DELETE so well-behaved servers can free the session.
    void s.transport.terminateSession().catch(() => {});
  }
  // client.close() also closes the transport.
  void s.client.close().catch(() => {});
}

function teardownSession(connectionId: string): void {
  const s = sessions.get(connectionId);
  if (!s) return;
  disposeSession(s);
  sessions.delete(connectionId);
}

export function registerMcpHandlerIPC(): void {
  ipcMain.handle(IPC.mcp.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.mcp.connect, event);
    const config = validateIpcInput(McpConnectSchema, rawConfig, IPC.mcp.connect);
    const webContentsId = event.sender.id;

    if (!mcpRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded.' };
    }
    if (sessions.size >= MAX_CONCURRENT_MCP) {
      return { success: false, error: 'Too many open MCP connections.' };
    }

    teardownSession(config.connectionId);

    // SSRF guard: resolve once, validate every record, and pin the connection
    // to the validated IP (closes the TTL=0 DNS-rebind window). MCP is
    // desktop-only; permit localhost (developers commonly run MCP servers
    // locally). SNI/Host stay on the original hostname.
    let pinnedFetch: typeof globalThis.fetch;
    try {
      const pinned = await resolveSafeAddress(config.url, { allowLocalhost: true });
      pinnedFetch = createPinnedFetch(pinned.host, pinned.ip);
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }

    bindRendererCleanup(sessions, event.sender, (deadId) => {
      disposeByOwner(sessions, deadId, disposeSession);
    });

    // User headers ride as the transport's base `requestInit`; the SDK applies
    // them to every request (the GET SSE stream included) and sets its own
    // protocol headers (Accept, Content-Type) after the merge, so they win.
    const transportOptions = {
      fetch: pinnedFetch as (url: string | URL, init?: RequestInit) => Promise<Response>,
      requestInit: { headers: config.headers ?? {} },
    };
    const url = new URL(config.url);
    const transport =
      config.transport === 'streamable-http'
        ? new StreamableHTTPClientTransport(url, transportOptions)
        : new SSEClientTransport(url, transportOptions);

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const session: McpSession = {
      connectionId: config.connectionId,
      url: config.url,
      webContentsId,
      createdAt: Date.now(),
      client,
      transport,
      disposed: false,
    };

    // Handlers go on the Client — Protocol.connect() overwrites the
    // transport's own onclose/onerror.
    client.fallbackNotificationHandler = async (notification) => {
      emitTo(
        webContentsId,
        eventChannel(EVENT_PREFIX.mcp.notification, config.connectionId),
        notification
      );
    };
    client.onerror = (err) => {
      if (session.disposed) return;
      emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.error, config.connectionId), {
        message: errorMessage(err),
      });
    };
    client.onclose = () => {
      if (session.disposed) return;
      session.disposed = true;
      if (sessions.get(config.connectionId) === session) {
        sessions.delete(config.connectionId);
        emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.close, config.connectionId), {
          reason: 'stream ended',
        });
      }
    };

    try {
      // Performs the full initialize handshake (and, for streamable-http,
      // opens the optional standalone SSE stream). Auth/connectivity errors
      // surface here rather than on the first request.
      await client.connect(transport);
      sessions.set(config.connectionId, session);
      emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.open, config.connectionId));
      return { success: true };
    } catch (err) {
      session.disposed = true;
      void client.close().catch(() => {});
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(
    IPC.mcp.request,
    rateLimited(
      mcpRateLimiter,
      createValidatedHandler(IPC.mcp.request, McpRequestSchema, async (config) => {
        const session = sessions.get(config.connectionId);
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
    createValidatedHandler(IPC.mcp.disconnect, McpDisconnectSchema, async (config) => {
      teardownSession(config.connectionId);
      return { success: true };
    })
  );
}

export function stopMcpCleanup(): void {
  for (const id of [...sessions.keys()]) teardownSession(id);
}
