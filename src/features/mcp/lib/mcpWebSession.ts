import { jsonRpcErrorToMessage } from '@shared/protocol/mcp-proxy';
import {
  isMcpNotificationMethod,
  isValidMcpProtocolVersion,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from '@shared/protocol/mcp-version';
import { workerAuthHeaders, workerBaseUrl } from '@/lib/shared/platform';
import type { McpTransportType } from '@/types';

/**
 * Web / self-host MCP session over the `/api/mcp` Worker proxy.
 *
 * The desktop app delegates the whole Streamable HTTP lifecycle to the
 * official SDK in the main process. The web client hand-rolls it here, per
 * MCP 2025-06-18 *Lifecycle* and *Streamable HTTP → Session Management*:
 *
 *  1. `initialize` is sent without `Mcp-Session-Id` / `MCP-Protocol-Version`,
 *     offering {@link MCP_LATEST_PROTOCOL_VERSION} (#862).
 *  2. The negotiated version is stored and `notifications/initialized` is sent
 *     BEFORE any other request is allowed through (#862).
 *  3. Every later request carries `MCP-Protocol-Version` (#865) and the
 *     server-assigned `Mcp-Session-Id`.
 *  4. A `404` on a request that carried a session id means the session
 *     expired: the client re-runs the handshake once and retries (#888).
 *  5. `terminate()` sends `DELETE` with `Mcp-Session-Id` via
 *     `/api/mcp/terminate` on disconnect (#888).
 *
 * Server-originated messages interleaved in an SSE reply are handed to
 * `onServerMessage`. Not supported on web: the standalone GET listening
 * stream and SSE resumption (`Last-Event-ID`) — see the MCP docs page.
 */

/** clientInfo sent in `initialize` — the real app version, not a placeholder. */
export function mcpClientInfo(name = 'restura'): { name: string; version: string } {
  return { name, version: import.meta.env.VITE_APP_VERSION || '0.0.0' };
}

/** Standard `initialize` params offering the latest supported protocol version. */
export function buildMcpInitializeParams(clientName = 'restura'): {
  protocolVersion: string;
  capabilities: Record<string, never>;
  clientInfo: { name: string; version: string };
} {
  return {
    protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: mcpClientInfo(clientName),
  };
}

export interface McpWebSessionOptions {
  url: string;
  transport: McpTransportType;
  headers: Record<string, string>;
  /** Receives server notifications/requests interleaved in an SSE reply. */
  onServerMessage?: (message: unknown) => void;
}

export type McpWebOutcome =
  | { ok: true; result: unknown; serverMessages?: unknown[] }
  | { ok: false; error: string; rawJsonRpcError?: unknown; upstreamStatus?: number };

interface ProxyBody {
  ok?: boolean;
  accepted?: boolean;
  jsonRpc?: { result?: unknown; error?: unknown };
  sessionId?: string;
  serverMessages?: unknown[];
  upstreamStatus?: number;
  error?: string;
}

export class McpWebSession {
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  /** Params of the last successful `initialize`, replayed on 404 re-init. */
  private initializeParams: unknown;
  /** Shared in-flight 404 re-initialize, so concurrent expiries open one session. */
  private reinitInFlight: Promise<McpWebOutcome> | undefined;
  /** Bumped by terminate(); responses from an older epoch must not (re)create a session. */
  private epoch = 0;

  constructor(
    private readonly opts: McpWebSessionOptions,
    private readonly nextId: () => number
  ) {}

  /** Version negotiated by the last successful `initialize`, if any. */
  get negotiatedProtocolVersion(): string | undefined {
    return this.protocolVersion;
  }

  /**
   * Send one JSON-RPC message. `initialize` runs the full handshake;
   * `notifications/*` are sent without an id; everything else is a request.
   */
  async call(method: string, params: unknown, timeout?: number): Promise<McpWebOutcome> {
    if (method === 'initialize') return this.initialize(params, timeout);

    const usedSession = this.sessionId;
    const first = await this.post(method, params, timeout);
    if (
      first.ok ||
      first.upstreamStatus !== 404 ||
      usedSession === undefined ||
      this.initializeParams === undefined
    ) {
      return first;
    }

    // 404 on a request carrying Mcp-Session-Id ⇒ session expired. The spec
    // says the client MUST start a new session by re-initializing; retry the
    // original call exactly once. Concurrent 404s share one re-init.
    // If the session already moved on (another call re-initialized), just retry.
    if (this.reinitInFlight || this.sessionId === usedSession) {
      this.reinitInFlight ??= this.reinitialize(timeout);
      const reinit = await this.reinitInFlight;
      if (!reinit.ok) {
        return { ...reinit, error: `MCP session expired; re-initialize failed: ${reinit.error}` };
      }
    }
    return this.post(method, params, timeout);
  }

  private async reinitialize(timeout?: number): Promise<McpWebOutcome> {
    try {
      this.sessionId = undefined; // expired — don't try to DELETE it
      return await this.initialize(this.initializeParams, timeout);
    } finally {
      this.reinitInFlight = undefined;
    }
  }

  /**
   * Terminate the server-side session (best-effort `DELETE`), then forget it.
   * Never throws: disconnect must always succeed locally.
   */
  async terminate(): Promise<void> {
    const sessionId = this.sessionId;
    const protocolVersion = this.protocolVersion;
    this.epoch++;
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.initializeParams = undefined;
    if (!sessionId || this.opts.transport !== 'streamable-http') return;
    await this.sendTerminate(sessionId, protocolVersion);
  }

  private async initialize(params: unknown, timeout?: number): Promise<McpWebOutcome> {
    // A fresh initialize starts a fresh session: end the previous one so the
    // server can free it, and never send the stale id/version on initialize.
    const previous = this.sessionId;
    const previousVersion = this.protocolVersion;
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    if (previous && this.opts.transport === 'streamable-http') {
      void this.sendTerminate(previous, previousVersion);
    }

    const epoch = this.epoch;
    const init = await this.post('initialize', params, timeout);
    if (!init.ok) return init;
    // Disconnected while initialize was in flight: post() already released the
    // orphaned server session; don't continue the handshake.
    if (epoch !== this.epoch)
      return { ok: false, error: 'MCP session terminated during initialize' };

    const negotiated = (init.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const offered = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (negotiated !== undefined && negotiated !== null) {
      // Lifecycle: the client SHOULD disconnect when it doesn't support the
      // server's version. Release the session the server just opened.
      if (
        !isValidMcpProtocolVersion(negotiated) ||
        !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)
      ) {
        const sid = this.sessionId;
        this.sessionId = undefined;
        if (sid && this.opts.transport === 'streamable-http')
          void this.sendTerminate(sid, undefined);
        return {
          ok: false,
          error: `Unsupported MCP protocol version negotiated by server: ${String(negotiated).slice(0, 64)}`,
        };
      }
      this.protocolVersion = negotiated;
    } else if (isValidMcpProtocolVersion(offered)) this.protocolVersion = offered;
    this.initializeParams = params;

    // Lifecycle: the client MUST send `initialized` before any other request.
    // Callers await this method before issuing list/call requests, so the
    // notification is guaranteed to be on the wire first.
    const initialized = await this.post('notifications/initialized', undefined, timeout);
    if (!initialized.ok) {
      return { ...initialized, error: `notifications/initialized failed: ${initialized.error}` };
    }
    return init;
  }

  private async post(method: string, params: unknown, timeout?: number): Promise<McpWebOutcome> {
    const isNotification = isMcpNotificationMethod(method);
    const isInitialize = method === 'initialize';
    const epoch = this.epoch;
    const response = await fetch(`${workerBaseUrl()}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
      body: JSON.stringify({
        url: this.opts.url,
        transport: this.opts.transport,
        headers: this.opts.headers,
        ...(this.sessionId && !isInitialize ? { sessionId: this.sessionId } : {}),
        ...(this.protocolVersion && !isInitialize ? { protocolVersion: this.protocolVersion } : {}),
        jsonRpc: {
          method,
          ...(isNotification ? {} : { id: this.nextId() }),
          ...(params !== undefined ? { params } : {}),
        },
        ...(timeout !== undefined ? { timeout } : {}),
      }),
    });
    const body = (await response.json()) as ProxyBody;
    if (body.sessionId) {
      if (epoch === this.epoch) this.sessionId = body.sessionId;
      else if (this.opts.transport === 'streamable-http')
        void this.sendTerminate(body.sessionId, undefined);
    }

    if (!response.ok) {
      return {
        ok: false,
        error: body.error ?? `HTTP ${response.status}`,
        ...(typeof body.upstreamStatus === 'number' ? { upstreamStatus: body.upstreamStatus } : {}),
      };
    }

    const serverMessages = Array.isArray(body.serverMessages) ? body.serverMessages : undefined;
    if (serverMessages && this.opts.onServerMessage) {
      for (const message of serverMessages) this.opts.onServerMessage(message);
    }
    if (body.jsonRpc?.error) {
      return {
        ok: false,
        error: jsonRpcErrorToMessage(body.jsonRpc.error),
        rawJsonRpcError: body.jsonRpc.error,
      };
    }
    return {
      ok: true,
      result: body.jsonRpc?.result,
      ...(serverMessages ? { serverMessages } : {}),
    };
  }

  private async sendTerminate(sessionId: string, protocolVersion: string | undefined) {
    try {
      await fetch(`${workerBaseUrl()}/api/mcp/terminate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
        body: JSON.stringify({
          url: this.opts.url,
          transport: this.opts.transport,
          headers: this.opts.headers,
          sessionId,
          ...(protocolVersion ? { protocolVersion } : {}),
        }),
      });
    } catch {
      /* best-effort: the server will expire the session on its own */
    }
  }
}
