import { jsonRpcErrorToMessage, parseJsonRpcError } from '@shared/protocol/mcp-proxy';
import { normalizeMcpToolDescriptor } from '@shared/protocol/mcp-tool-descriptor';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import type {
  AuthConfig,
  McpJsonSchema,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServerCapabilities,
  McpToolDescriptor,
  McpTransportType,
} from '@/types';
import { buildMcpInitializeParams, McpWebSession } from './mcpWebSession';

/** Result of one JSON-RPC call */
export interface McpCallResult<T = unknown> {
  ok: true;
  result: T;
  durationMs: number;
  /** Web: server notifications/requests interleaved in the SSE reply (#888). */
  serverMessages?: unknown[];
}

export interface McpCallError {
  ok: false;
  error: string;
  /** #856: the desktop OAuth sign-in lapsed and couldn't refresh — prompt to reconnect. */
  authRequired?: boolean;
  jsonRpcError?: { code: number; message: string; data?: unknown };
  durationMs: number;
}

export type McpCall<T = unknown> = McpCallResult<T> | McpCallError;

/** Page shapes for the paginated list methods. `nextCursor` drives the loop. */
interface ListPage<T> {
  nextCursor?: string;
  items?: T[];
}
interface ToolsListResult {
  tools?: unknown[];
  nextCursor?: string;
}
interface ResourcesListResult {
  resources?: McpResourceDescriptor[];
  nextCursor?: string;
}
interface PromptsListResult {
  prompts?: McpPromptDescriptor[];
  nextCursor?: string;
}

/** Cap on pagination iterations to defend against a server that never stops. */
const MAX_LIST_PAGES = 100;

interface McpClientOptions {
  url: string;
  transport: McpTransportType;
  headers: Record<string, string>;
  /**
   * Desktop only (#896): header-shaped auth Electron main resolves at connect
   * time (SecretRef handles stay opaque here). On web, credentials are already
   * applied into `headers` — see `buildMcpConnectAuth`.
   */
  auth?: AuthConfig;
  /** Stable identifier for the connection (used to key Electron IPC sessions) */
  connectionId: string;
  /** Web: receives server-originated messages interleaved in SSE replies. */
  onServerMessage?: (message: unknown) => void;
}

/**
 * MCP client. Branches on `isElectron()`:
 *  - Electron: uses native IPC handler (`window.electron.mcp.*`).
 *  - Web: uses the `/api/mcp` Worker proxy.
 *
 * The renderer surface is the same in both — caller doesn't need to branch.
 */
export class McpClient {
  /** Counter for client-generated request ids */
  private nextId = 1;
  /** Web-mode Streamable HTTP session state (session id, negotiated version). */
  private readonly web: McpWebSession;
  /** Protocol version negotiated by the last successful `initialize`. */
  private negotiatedVersion?: string;

  constructor(private opts: McpClientOptions) {
    this.web = new McpWebSession(
      {
        url: opts.url,
        transport: opts.transport,
        headers: opts.headers,
        ...(opts.onServerMessage ? { onServerMessage: opts.onServerMessage } : {}),
      },
      () => this.nextId++
    );
  }

  /** Protocol version negotiated with the server (after `initialize`). */
  get protocolVersion(): string | undefined {
    return this.negotiatedVersion;
  }

  /**
   * Open the transport. Required before `request` for http-sse (so we can
   * receive the `endpoint` event); a no-op for streamable-http but still
   * useful to surface auth errors early.
   */
  async connect(): Promise<{ ok: true } | { ok: false; error: string; authRequired?: boolean }> {
    if (isElectron()) {
      const api = getElectronAPI();
      if (!api?.mcp) return { ok: false, error: 'Electron MCP API not available' };
      const res = await api.mcp.connect({
        connectionId: this.opts.connectionId,
        url: this.opts.url,
        transport: this.opts.transport,
        headers: this.opts.headers,
        ...(this.opts.auth ? { auth: this.opts.auth } : {}),
      });
      if (res.success) return { ok: true };
      return {
        ok: false,
        error: res.error ?? 'Connect failed',
        ...(res.authRequired ? { authRequired: true } : {}),
      };
    }

    // Web mode: streamable-http requires no setup; http-sse needs the persistent stream.
    if (this.opts.transport === 'http-sse') {
      // For now web mode doesn't support http-sse subscriptions through the Worker
      // (the Worker proxy is request/response). Surface that limitation explicitly
      // rather than failing later in a confusing way.
      return {
        ok: false,
        error:
          'http-sse transport is not supported in web mode (use streamable-http or the desktop app)',
      };
    }
    return { ok: true };
  }

  async disconnect(): Promise<void> {
    if (isElectron()) {
      const api = getElectronAPI();
      await api?.mcp?.disconnect({ connectionId: this.opts.connectionId });
      return;
    }
    // Web: end the server-side session with DELETE + Mcp-Session-Id (#888).
    this.negotiatedVersion = undefined;
    await this.web.terminate();
  }

  /** Send one JSON-RPC request; resolves with either a result or an error wrapper. */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeout?: number
  ): Promise<McpCall<T>> {
    const start = performance.now();
    const requestId = this.nextId++;
    try {
      if (isElectron()) {
        const api = getElectronAPI();
        if (!api?.mcp) {
          return { ok: false, error: 'Electron MCP API not available', durationMs: 0 };
        }
        const res = await api.mcp.request({
          connectionId: this.opts.connectionId,
          method,
          ...(params !== undefined ? { params } : {}),
          requestId,
          ...(timeout !== undefined ? { timeout } : {}),
        });
        const durationMs = performance.now() - start;
        if (res.success) {
          if (method === 'initialize') {
            const v = (res.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
            if (typeof v === 'string') this.negotiatedVersion = v;
          }
          return { ok: true, result: res.result as T, durationMs };
        }
        const jsonRpcError = parseJsonRpcError(res.jsonRpcError);
        return {
          ok: false,
          error: jsonRpcError
            ? jsonRpcErrorToMessage(jsonRpcError)
            : (res.error ?? 'MCP request failed'),
          ...(jsonRpcError ? { jsonRpcError } : {}),
          ...(res.authRequired ? { authRequired: true } : {}),
          durationMs,
        };
      }

      // Web: `initialize` runs the full handshake (incl. notifications/initialized);
      // later calls carry Mcp-Session-Id + MCP-Protocol-Version and survive one 404.
      const outcome = await this.web.call(method, params, timeout);
      const durationMs = performance.now() - start;
      if (!outcome.ok) {
        const jsonRpcError = parseJsonRpcError(outcome.rawJsonRpcError);
        return {
          ok: false,
          error: outcome.error,
          ...(jsonRpcError ? { jsonRpcError } : {}),
          durationMs,
        };
      }
      if (method === 'initialize') this.negotiatedVersion = this.web.negotiatedProtocolVersion;
      return {
        ok: true,
        result: outcome.result as T,
        durationMs,
        ...(outcome.serverMessages ? { serverMessages: outcome.serverMessages } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        durationMs: performance.now() - start,
      };
    }
  }

  /**
   * Drive an MCP list method (`tools/list` etc.) to completion, following `nextCursor`
   * pagination. The first call omits `cursor`; subsequent calls pass the opaque
   * cursor from the previous page. Stops when `nextCursor` is absent, the page
   * cap is hit, or a cursor repeats (loop guard). On a failed page it returns
   * whatever was accumulated so far — never throws, matching the existing
   * "failed list collapses to a partial/empty array" behavior.
   */
  private async listAll<R, T>(method: string, pick: (result: R) => ListPage<T>): Promise<T[]> {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await this.request<R>(method, cursor !== undefined ? { cursor } : undefined);
      if (!res.ok) break;
      const { items: pageItems, nextCursor } = pick(res.result);
      if (pageItems) items.push(...pageItems);
      if (nextCursor === undefined || nextCursor === '') break;
      if (seenCursors.has(nextCursor)) break; // cursor repeated — bail to avoid an infinite loop
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return items;
  }

  /** Run the standard discovery: initialize, then list tools/resources/prompts. */
  async discoverCapabilities(): Promise<McpServerCapabilities | { error: string }> {
    const init = await this.request<{
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: McpServerCapabilities['capabilities'];
    }>('initialize', buildMcpInitializeParams());
    if (!init.ok) return { error: init.error };

    // Only issue list calls for capabilities the server advertised in `initialize`.
    // If the server didn't return a `capabilities` block at all (older servers), try
    // all three — they're cheap on a working server, and method-not-found is harmless.
    const advertised = init.result.capabilities;
    const wantTools = !advertised || advertised.tools !== undefined;
    const wantResources = !advertised || advertised.resources !== undefined;
    const wantPrompts = !advertised || advertised.prompts !== undefined;

    // Each list paginates sequentially (cursor-driven), but the three run
    // concurrently — same shape as the old single-shot Promise.all.
    const [tools, resources, prompts] = await Promise.all([
      wantTools
        ? this.listAll<ToolsListResult, McpToolDescriptor>('tools/list', (r) => ({
            // Same normalizer for desktop (SDK result) and web (Worker JSON-RPC body).
            items: r.tools
              ?.map(normalizeMcpToolDescriptor)
              .filter((t): t is McpToolDescriptor => t !== null),
            nextCursor: r.nextCursor,
          }))
        : [],
      wantResources
        ? this.listAll<ResourcesListResult, McpResourceDescriptor>('resources/list', (r) => ({
            items: r.resources,
            nextCursor: r.nextCursor,
          }))
        : [],
      wantPrompts
        ? this.listAll<PromptsListResult, McpPromptDescriptor>('prompts/list', (r) => ({
            items: r.prompts,
            nextCursor: r.nextCursor,
          }))
        : [],
    ]);

    return {
      ...(init.result.serverInfo?.name ? { serverName: init.result.serverInfo.name } : {}),
      ...(init.result.serverInfo?.version ? { serverVersion: init.result.serverInfo.version } : {}),
      ...(this.negotiatedVersion ? { protocolVersion: this.negotiatedVersion } : {}),
      ...(advertised ? { capabilities: advertised } : {}),
      tools,
      resources,
      prompts,
    };
  }

  /** Convenience wrappers for the common per-capability calls. */
  callTool(name: string, args: unknown): Promise<McpCall> {
    return this.request('tools/call', { name, arguments: args });
  }

  readResource(uri: string): Promise<McpCall> {
    return this.request('resources/read', { uri });
  }

  /**
   * Desktop main picks the era-correct wire method: `resources/subscribe` on
   * 2025-era servers, a `subscriptions/listen` stream on 2026-07-28 (#872).
   */
  subscribeResource(uri: string): Promise<McpCall> {
    return this.request('resources/subscribe', { uri });
  }

  unsubscribeResource(uri: string): Promise<McpCall> {
    return this.request('resources/unsubscribe', { uri });
  }

  getPrompt(name: string, args?: Record<string, string>): Promise<McpCall> {
    return this.request('prompts/get', { name, ...(args ? { arguments: args } : {}) });
  }
}

// Re-export the schema helper here so consumers have one import surface
export { generateMcpTemplate } from './mcpSchemaTemplate';
export type { McpJsonSchema };
