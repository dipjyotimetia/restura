import { isElectron, getElectronAPI, workerBaseUrl } from '@/lib/shared/platform';
import type {
  McpJsonSchema,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServerCapabilities,
  McpToolDescriptor,
  McpTransportType,
} from '@/types';

/** Result of one JSON-RPC call */
export interface McpCallResult<T = unknown> {
  ok: true;
  result: T;
  durationMs: number;
}

export interface McpCallError {
  ok: false;
  error: string;
  jsonRpcError?: { code: number; message: string; data?: unknown };
  durationMs: number;
}

export type McpCall<T = unknown> = McpCallResult<T> | McpCallError;

interface McpClientOptions {
  url: string;
  transport: McpTransportType;
  headers: Record<string, string>;
  /** Stable identifier for the connection (used to key Electron IPC sessions) */
  connectionId: string;
}

/**
 * MCP client. Branches on `isElectron()`:
 *  - Electron: uses native IPC handler (`window.electron.mcp.*`).
 *  - Web: uses the `/api/mcp` Worker proxy.
 *
 * The renderer surface is the same in both — caller doesn't need to branch.
 */
export class McpClient {
  /** Mcp-Session-Id captured from a streamable-http response */
  private sessionId?: string;
  /** Counter for client-generated request ids */
  private nextId = 1;

  constructor(private opts: McpClientOptions) {}

  /**
   * Open the transport. Required before `request` for http-sse (so we can
   * receive the `endpoint` event); a no-op for streamable-http but still
   * useful to surface auth errors early.
   */
  async connect(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (isElectron()) {
      const api = getElectronAPI();
      if (!api?.mcp) return { ok: false, error: 'Electron MCP API not available' };
      const res = await api.mcp.connect({
        connectionId: this.opts.connectionId,
        url: this.opts.url,
        transport: this.opts.transport,
        headers: this.opts.headers,
      });
      return res.success ? { ok: true } : { ok: false, error: res.error ?? 'Connect failed' };
    }

    // Web mode: streamable-http requires no setup; http-sse needs the persistent stream.
    if (this.opts.transport === 'http-sse') {
      // For now web mode doesn't support http-sse subscriptions through the Worker
      // (the Worker proxy is request/response). Surface that limitation explicitly
      // rather than failing later in a confusing way.
      return {
        ok: false,
        error: 'http-sse transport is not supported in web mode (use streamable-http or the desktop app)',
      };
    }
    return { ok: true };
  }

  async disconnect(): Promise<void> {
    if (isElectron()) {
      const api = getElectronAPI();
      await api?.mcp?.disconnect({ connectionId: this.opts.connectionId });
    }
    // Web has no persistent state — nothing to tear down
  }

  /** Send one JSON-RPC request; resolves with either a result or an error wrapper. */
  async request<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<McpCall<T>> {
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
          return { ok: true, result: res.result as T, durationMs };
        }
        return {
          ok: false,
          error: res.error ?? 'MCP request failed',
          ...(res.jsonRpcError ? { jsonRpcError: res.jsonRpcError } : {}),
          durationMs,
        };
      }

      const response = await fetch(`${workerBaseUrl()}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: this.opts.url,
          transport: this.opts.transport,
          headers: this.opts.headers,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          jsonRpc: { method, id: requestId, ...(params !== undefined ? { params } : {}) },
          ...(timeout !== undefined ? { timeout } : {}),
        }),
      });
      const durationMs = performance.now() - start;
      const body = await response.json() as {
        ok?: boolean;
        jsonRpc?: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        sessionId?: string;
        error?: string;
      };
      if (body.sessionId) this.sessionId = body.sessionId;

      if (!response.ok) {
        return { ok: false, error: body.error ?? `HTTP ${response.status}`, durationMs };
      }
      if (body.jsonRpc?.error) {
        return { ok: false, error: body.jsonRpc.error.message, jsonRpcError: body.jsonRpc.error, durationMs };
      }
      return { ok: true, result: body.jsonRpc?.result as T, durationMs };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        durationMs: performance.now() - start,
      };
    }
  }

  /** Run the standard discovery: initialize, then list tools/resources/prompts. */
  async discoverCapabilities(): Promise<McpServerCapabilities | { error: string }> {
    const init = await this.request<{
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: McpServerCapabilities['capabilities'];
    }>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'restura', version: '1.0.0' },
    });
    if (!init.ok) return { error: init.error };

    // Only issue list calls for capabilities the server advertised in `initialize`.
    // If the server didn't return a `capabilities` block at all (older servers), try
    // all three — they're cheap on a working server, and method-not-found is harmless.
    const advertised = init.result.capabilities;
    const wantTools = !advertised || advertised.tools !== undefined;
    const wantResources = !advertised || advertised.resources !== undefined;
    const wantPrompts = !advertised || advertised.prompts !== undefined;

    const [tools, resources, prompts] = await Promise.all([
      wantTools ? this.request<{ tools?: McpToolDescriptor[] }>('tools/list') : null,
      wantResources ? this.request<{ resources?: McpResourceDescriptor[] }>('resources/list') : null,
      wantPrompts ? this.request<{ prompts?: McpPromptDescriptor[] }>('prompts/list') : null,
    ]);

    return {
      ...(init.result.serverInfo?.name ? { serverName: init.result.serverInfo.name } : {}),
      ...(init.result.serverInfo?.version ? { serverVersion: init.result.serverInfo.version } : {}),
      ...(init.result.protocolVersion ? { protocolVersion: init.result.protocolVersion } : {}),
      ...(advertised ? { capabilities: advertised } : {}),
      tools: tools?.ok ? tools.result.tools ?? [] : [],
      resources: resources?.ok ? resources.result.resources ?? [] : [],
      prompts: prompts?.ok ? prompts.result.prompts ?? [] : [],
    };
  }

  /** Convenience wrappers for the common per-capability calls. */
  callTool(name: string, args: unknown): Promise<McpCall> {
    return this.request('tools/call', { name, arguments: args });
  }

  readResource(uri: string): Promise<McpCall> {
    return this.request('resources/read', { uri });
  }

  getPrompt(name: string, args?: Record<string, string>): Promise<McpCall> {
    return this.request('prompts/get', { name, ...(args ? { arguments: args } : {}) });
  }
}

// Re-export the schema helper here so consumers have one import surface
export { generateMcpTemplate } from './mcpSchemaTemplate';
export type { McpJsonSchema };
