import { jsonRpcErrorToMessage, parseJsonRpcError } from '@shared/protocol/mcp-proxy';
import { normalizeMcpToolDescriptor } from '@shared/protocol/mcp-tool-descriptor';
import type { SecretValue } from '@shared/secrets/secret-ref';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import type {
  AuthConfig,
  McpJsonSchema,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpServerCapabilities,
  McpToolDescriptor,
  McpTransportType,
} from '@/types';
import { EVENT_PREFIX, eventChannel } from '../../../../electron/shared/channels';
import { MCP_STDIO_WEB_ERROR } from './mcpStdioLaunch';
import { buildMcpInitializeParams, McpWebSession } from './mcpWebSession';

/** RFC 5424 syslog levels accepted by `logging/setLevel` (MCP 2025-06-18). */
export const MCP_LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const;
export type McpLogLevel = (typeof MCP_LOG_LEVELS)[number];

/** Reference types for `completion/complete`. */
export type McpCompletionRef =
  | { type: 'ref/prompt'; name: string }
  | { type: 'ref/resource'; uri: string };

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
  /** True when the user cancelled the call; distinct from a failure. */
  cancelled?: true;
  durationMs: number;
}

export { MCP_CANCEL_REASON } from './mcpWebSession';

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
interface ResourceTemplatesListResult {
  resourceTemplates?: McpResourceTemplateDescriptor[];
  nextCursor?: string;
}
interface PromptsListResult {
  prompts?: McpPromptDescriptor[];
  nextCursor?: string;
}

/** Cap on pagination iterations to defend against a server that never stops. */
const MAX_LIST_PAGES = 100;

/** Resolved stdio launch config for `transport: 'stdio'` (desktop only). */
export interface McpClientStdioOptions {
  command: string;
  args: string[];
  cwd?: string;
  /** Values may be SecretRef handles — main resolves them at spawn time. */
  env?: Record<string, SecretValue>;
}

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
  stdio?: McpClientStdioOptions;
  /** Bounded stderr text from a stdio server process. */
  onStderr?: (text: string) => void;
  /** Web: receives server-originated messages interleaved in SSE replies. */
  onServerMessage?: (message: unknown) => void;
}

type StdioEnvIpc = Record<
  string,
  string | { kind: 'inline'; value: string } | { kind: 'handle'; id: string; label?: string }
>;

/** External vault refs are not resolvable in the stdio spawn path. */
function toStdioEnvIpc(
  env: Record<string, SecretValue> | undefined
): { ok: true; env: StdioEnvIpc } | { ok: false; error: string } {
  const out: StdioEnvIpc = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === 'object' && value.kind === 'external') {
      return {
        ok: false,
        error: `Environment variable ${name}: external vault secrets are not supported for stdio servers`,
      };
    }
    out[name] = value;
  }
  return { ok: true, env: out };
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
  /** Unsubscribe for the stdio stderr listener (Electron only). */
  private stderrUnsubscribe: (() => void) | undefined;
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
      if (this.opts.transport === 'stdio') return this.connectStdio(api.mcp);
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

    if (this.opts.transport === 'stdio') return { ok: false, error: MCP_STDIO_WEB_ERROR };

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

  /**
   * stdio: subscribe to the stderr channel BEFORE invoking connect (spawn
   * errors such as "command not found" arrive during the handshake), then
   * ask main to spawn. Main shows its own consent dialog; nothing here can
   * approve a launch.
   */
  private async connectStdio(
    mcp: NonNullable<ReturnType<typeof getElectronAPI>>['mcp']
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const stdio = this.opts.stdio;
    if (!stdio?.command.trim()) return { ok: false, error: 'A command is required for stdio' };
    const env = toStdioEnvIpc(stdio.env);
    if (!env.ok) return env;
    this.subscribeStderr(mcp);
    const res = await mcp.connect({
      connectionId: this.opts.connectionId,
      transport: 'stdio',
      command: stdio.command.trim(),
      args: stdio.args,
      ...(stdio.cwd?.trim() ? { cwd: stdio.cwd.trim() } : {}),
      ...(Object.keys(env.env).length > 0 ? { env: env.env } : {}),
    });
    if (!res.success) {
      this.unsubscribeStderr();
      return { ok: false, error: res.error ?? 'Connect failed' };
    }
    return { ok: true };
  }

  private subscribeStderr(mcp: NonNullable<ReturnType<typeof getElectronAPI>>['mcp']): void {
    this.unsubscribeStderr();
    const onStderr = this.opts.onStderr;
    if (!onStderr) return;
    const channel = eventChannel(EVENT_PREFIX.mcp.stderr, this.opts.connectionId);
    const listener = (payload: unknown) => {
      const text = (payload as { text?: unknown } | undefined)?.text;
      if (typeof text === 'string') onStderr(text);
    };
    mcp.on(channel, listener);
    this.stderrUnsubscribe = () => mcp.removeListener(channel, listener);
  }

  private unsubscribeStderr(): void {
    this.stderrUnsubscribe?.();
    this.stderrUnsubscribe = undefined;
  }

  /**
   * Drop this client's local listeners (stdio stderr) without telling main —
   * for a session the server already closed. Without it a dead client's
   * stderr listener survives, and the next connect on the same connection id
   * adds a second one (every stderr line shown twice).
   */
  release(): void {
    this.unsubscribeStderr();
  }

  async disconnect(): Promise<void> {
    this.unsubscribeStderr();
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
    timeout?: number,
    signal?: AbortSignal
  ): Promise<McpCall<T>> {
    const start = performance.now();
    const requestId = this.nextId++;
    const cancelled = (): McpCallError => ({
      ok: false,
      error: 'Request cancelled',
      cancelled: true,
      durationMs: performance.now() - start,
    });
    if (signal?.aborted) return cancelled();
    try {
      if (isElectron()) {
        const api = getElectronAPI();
        if (!api?.mcp) {
          return { ok: false, error: 'Electron MCP API not available', durationMs: 0 };
        }
        const pending = api.mcp.request({
          connectionId: this.opts.connectionId,
          method,
          ...(params !== undefined ? { params } : {}),
          requestId,
          ...(timeout !== undefined ? { timeout } : {}),
        });
        let res: Awaited<typeof pending>;
        if (signal) {
          // Main aborts the SDK request (which sends notifications/cancelled).
          // Settle immediately so a late response can never overwrite the
          // cancelled state.
          let onAbort: () => void = () => undefined;
          const aborted = new Promise<'aborted'>((resolve) => {
            onAbort = () => {
              void api.mcp
                .cancel({ connectionId: this.opts.connectionId, requestId })
                .catch(() => undefined);
              resolve('aborted');
            };
            signal.addEventListener('abort', onAbort, { once: true });
          });
          pending.catch(() => undefined);
          try {
            const outcome = await Promise.race([pending, aborted]);
            if (outcome === 'aborted') return cancelled();
            res = outcome;
          } finally {
            signal.removeEventListener('abort', onAbort);
          }
        } else {
          res = await pending;
        }
        if (res.cancelled) return cancelled();
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

      if (this.opts.transport === 'stdio') {
        return { ok: false, error: MCP_STDIO_WEB_ERROR, durationMs: 0 };
      }
      // Web: `initialize` runs the full handshake (incl. notifications/initialized);
      // later calls carry Mcp-Session-Id + MCP-Protocol-Version and survive one 404.
      const outcome = await this.web.call(method, params, timeout, signal);
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
      // An abort (user cancel) rejects the fetch / body read; report it as
      // cancelled, never as a failure, and drop whatever the server sends later.
      if (signal?.aborted) return cancelled();
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
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
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
      // Templates belong to the `resources` capability (MCP 2025-06-18).
      wantResources
        ? this.listAll<ResourceTemplatesListResult, McpResourceTemplateDescriptor>(
            'resources/templates/list',
            (r) => ({ items: r.resourceTemplates, nextCursor: r.nextCursor })
          )
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
      resourceTemplates,
      prompts,
    };
  }

  /** Convenience wrappers for the common per-capability calls. */
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCall> {
    return this.request('tools/call', { name, arguments: args }, undefined, signal);
  }

  readResource(uri: string, signal?: AbortSignal): Promise<McpCall> {
    return this.request('resources/read', { uri }, undefined, signal);
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

  /** `ping` — resolves with the round-trip time in `durationMs`. */
  ping(): Promise<McpCall> {
    return this.request('ping');
  }

  /** `logging/setLevel` — only valid when the server advertises `logging`. */
  setLogLevel(level: McpLogLevel): Promise<McpCall> {
    return this.request('logging/setLevel', { level });
  }

  /**
   * `completion/complete` — argument autocompletion for a prompt or a resource
   * template. Never throws: a server that rejects the call (or does not
   * implement it) yields no suggestions.
   */
  async complete(
    ref: McpCompletionRef,
    argument: { name: string; value: string },
    contextArguments?: Record<string, string>
  ): Promise<string[]> {
    const res = await this.request<{ completion?: { values?: unknown } }>('completion/complete', {
      ref,
      argument,
      ...(contextArguments && Object.keys(contextArguments).length > 0
        ? { context: { arguments: contextArguments } }
        : {}),
    });
    if (!res.ok) return [];
    const values = res.result?.completion?.values;
    return Array.isArray(values)
      ? values.filter((v): v is string => typeof v === 'string').slice(0, 100)
      : [];
  }

  getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<McpCall> {
    return this.request(
      'prompts/get',
      { name, ...(args ? { arguments: args } : {}) },
      undefined,
      signal
    );
  }
}

// Re-export the schema helper here so consumers have one import surface
export { generateMcpTemplate } from './mcpSchemaTemplate';
export type { McpJsonSchema };
