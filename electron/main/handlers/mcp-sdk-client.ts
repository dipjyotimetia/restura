import {
  type AuthProvider,
  Client,
  type ClientNotification,
  type ClientRequest,
  type CreateMessageResult,
  type ElicitResult,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import type { TrackedChild } from './mcp-stdio-session';
import { McpSubscriptionManager } from './mcp-subscriptions';

export type McpSdkTransport = 'streamable-http' | 'http-sse';

/**
 * Fully resolved stdio launch (secrets already materialized, env already
 * allowlisted — see security/mcp-stdio-policy.ts). Spawned by the SDK's
 * `StdioClientTransport`, which uses cross-spawn with `shell: false`.
 */
export interface McpSdkStdioParams {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onStderr?: (chunk: Buffer | string) => void;
  /** Called once the OS process exists, before the MCP handshake. */
  onSpawn?: (child: TrackedChild) => void;
}

export interface McpSdkTransportOptions {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  requestInit: RequestInit;
  /** MCP OAuth 2.1 (#856): main-side token source + 401 handler. */
  authProvider?: AuthProvider;
}

export interface McpSdkClientEvents {
  onNotification: (notification: unknown) => Promise<void>;
  onError: (error: Error) => void;
  onClose: () => void;
}

export interface McpSdkClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  terminateSession(): Promise<void>;
  /**
   * `signal` aborts the in-flight request; the SDK then sends
   * `notifications/cancelled` for its JSON-RPC id and ignores any late reply.
   */
  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown>;
  notification(method: string, params: unknown): Promise<void>;
  getProtocolVersion(): string;
  getServerCapabilities(): unknown;
  getServerVersion(): unknown;
  setEvents(events: McpSdkClientEvents): void;
  sendRootsListChanged(): Promise<void>;
}

/**
 * Server→client request handlers (#860). When supplied, the client advertises
 * the elicitation (form mode), sampling and roots{listChanged} capabilities;
 * the same handlers also fulfil 2026-07-28 `input_required` rounds.
 */
export interface McpSdkClientRequestHandlers {
  elicit(params: unknown, signal: AbortSignal): Promise<Record<string, unknown>>;
  createMessage(params: unknown, signal: AbortSignal): Promise<Record<string, unknown>>;
  listRoots(): { roots: Array<{ uri: string; name?: string | undefined }> };
}

interface McpSdkConnectCommon {
  events?: McpSdkClientEvents;
  clientRequests?: McpSdkClientRequestHandlers;
  onClientCreated?: (client: McpSdkClient) => void;
  /**
   * Pin the protocol era (conformance runs, #911). Default: auto-negotiate with
   * legacy fallback, which is what interactive sessions use.
   */
  era?: 'legacy' | 'modern';
}

export type McpSdkConnectOptions =
  | (McpSdkConnectCommon & {
      url: URL;
      transport: McpSdkTransport;
      transportOptions: McpSdkTransportOptions;
    })
  | (McpSdkConnectCommon & { transport: 'stdio'; stdio: McpSdkStdioParams });

/** First revision of the modern (server/discover) era. */
export const MCP_MODERN_PIN = '2026-07-28';

const CLIENT_INFO = { name: 'restura', version: '1.0.0' };
// Standard MCP methods are dispatched through the SDK's typed APIs below.
// The renderer may also inspect a server extension. v2 requires an explicit
// result schema for that opt-in path so a remote JSON-RPC error still reaches
// the caller instead of failing local request validation.
const EXTENSION_RESULT_SCHEMA = z.unknown();
// URL-mode elicitation is deliberately not advertised: it asks the client to
// open a server-chosen URL, which needs its own consent/SSRF design.
const CLIENT_REQUEST_CAPABILITIES = {
  elicitation: { form: {} },
  sampling: {},
  roots: { listChanged: true },
};

/**
 * Build the SDK stdio transport. Two deliberate choices:
 *  - `stderr: 'pipe'` so output reaches the UI log (bounded by the caller)
 *    instead of being inherited onto Restura's own stderr.
 *  - The process handle is surfaced via `onSpawn` so main can track and kill
 *    it. The SDK keeps it private (`_process`); we read it right after
 *    `start()` and fail closed (kill via close) if the shape ever changes.
 */
function createStdioTransport(params: McpSdkStdioParams): StdioClientTransport {
  const transport = new StdioClientTransport({
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    stderr: 'pipe',
  });
  if (params.onStderr) transport.stderr?.on('data', params.onStderr);
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    const child = (transport as unknown as { _process?: TrackedChild })._process;
    if (!child || typeof child.once !== 'function') {
      await transport.close().catch(() => undefined);
      throw new Error('MCP stdio transport did not expose its child process; refusing to run');
    }
    params.onSpawn?.(child);
  };
  return transport;
}

class ResturaMcpSdkClient implements McpSdkClient {
  private readonly transport:
    | StreamableHTTPClientTransport
    | SSEClientTransport
    | StdioClientTransport;
  private readonly client: Client;
  private events: McpSdkClientEvents | undefined;
  private progressSeq = 0;
  /** Era-aware resources/subscribe vs subscriptions/listen (#872). */
  private readonly subscriptions: McpSubscriptionManager;

  constructor(options: McpSdkConnectOptions) {
    let versionMode: 'auto' | 'legacy' | { pin: string } =
      options.era === 'legacy'
        ? 'legacy'
        : options.era === 'modern'
          ? { pin: MCP_MODERN_PIN }
          : 'auto';
    if (options.transport === 'stdio') {
      this.transport = createStdioTransport(options.stdio);
      // stdio uses the plain `initialize` handshake. `auto` negotiation would
      // spawn a hidden second copy of the server (the SDK's disposable
      // "sibling" probe) — an extra, untracked launch of a user-approved
      // command whose stderr is discarded. One consented launch, one process.
      versionMode = 'legacy';
    } else {
      this.transport =
        options.transport === 'streamable-http'
          ? new StreamableHTTPClientTransport(options.url, options.transportOptions)
          : new SSEClientTransport(options.url, options.transportOptions);
    }
    this.client = new Client(CLIENT_INFO, {
      capabilities: options.clientRequests ? CLIENT_REQUEST_CAPABILITIES : {},
      versionNegotiation: { mode: versionMode },
    });
    if (options.clientRequests) installClientRequestHandlers(this.client, options.clientRequests);
    this.subscriptions = new McpSubscriptionManager(this.client, (notification) => {
      void this.events?.onNotification(notification);
    });
    if (options.events) this.setEvents(options.events);
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    // Modern servers only push list_changed on a listen stream (#858). Open it
    // in the background so a slow/absent ack never blocks the connect.
    void this.subscriptions.openListChangedStream().catch((err: unknown) => {
      this.events?.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  close(): Promise<void> {
    // closeAll() starts every listen-stream close synchronously, so the
    // cancels go out before the client (and transport) close — which itself
    // must start synchronously for the handler's dispose paths.
    const closingSubscriptions = this.subscriptions.closeAll();
    return Promise.all([closingSubscriptions, this.client.close()]).then(() => undefined);
  }

  async terminateSession(): Promise<void> {
    if (this.transport instanceof StreamableHTTPClientTransport) {
      await this.transport.terminateSession();
    }
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const options = { timeout: timeoutMs, ...(signal ? { signal } : {}) };
    switch (method) {
      case 'ping':
        return this.client.ping(options);
      case 'server/discover':
        return this.client.discover(options);
      case 'completion/complete':
        return this.client.complete(params as Parameters<Client['complete']>[0], options);
      case 'logging/setLevel':
        return this.client.setLoggingLevel(
          (params as { level: Parameters<Client['setLoggingLevel']>[0] }).level,
          options
        );
      case 'tools/list':
        return this.client.listTools(params as Parameters<Client['listTools']>[0], options);
      case 'tools/call':
        return this.client.callTool(params as Parameters<Client['callTool']>[0], {
          ...options,
          onprogress: this.progressForwarder(method, params),
        });
      case 'resources/list':
        return this.client.listResources(params as Parameters<Client['listResources']>[0], options);
      case 'resources/templates/list':
        return this.client.listResourceTemplates(
          params as Parameters<Client['listResourceTemplates']>[0],
          options
        );
      case 'resources/read':
        return this.client.readResource(params as Parameters<Client['readResource']>[0], options);
      case 'resources/subscribe':
        return this.subscriptions.subscribeResource(params, options);
      case 'resources/unsubscribe':
        return this.subscriptions.unsubscribeResource(params, options);
      case 'subscriptions/listen':
        // A listen stream is a long-lived handle, not a request/response; it
        // can't round-trip over IPC. Restura opens and owns these streams.
        return Promise.reject(
          new Error(
            'subscriptions/listen is managed by Restura: use resources/subscribe (list_changed streams open automatically)'
          )
        );
      case 'prompts/list':
        return this.client.listPrompts(params as Parameters<Client['listPrompts']>[0], options);
      case 'prompts/get':
        return this.client.getPrompt(params as Parameters<Client['getPrompt']>[0], options);
      default:
        return this.client.request(
          { method, params } as ClientRequest,
          EXTENSION_RESULT_SCHEMA,
          options
        );
    }
  }

  /**
   * Forward `notifications/progress` for an in-flight call to the renderer.
   * Supplying `onprogress` makes the SDK attach a progressToken; without it
   * servers never send progress at all.
   */
  private progressForwarder(method: string, params: unknown) {
    const progressKey = `${method}#${++this.progressSeq}`;
    const name = (params as { name?: unknown } | undefined)?.name;
    return (progress: { progress: number; total?: number; message?: string }) => {
      void this.events?.onNotification({
        method: 'notifications/progress',
        params: {
          ...progress,
          progressKey,
          requestMethod: method,
          ...(typeof name === 'string' ? { name } : {}),
        },
      });
    };
  }

  notification(method: string, params: unknown): Promise<void> {
    return this.client.notification({ method, params } as ClientNotification);
  }

  getProtocolVersion(): string {
    const protocolVersion = this.client.getNegotiatedProtocolVersion();
    if (!protocolVersion) {
      throw new Error('MCP client connected without a negotiated protocol version');
    }
    return protocolVersion;
  }

  getServerCapabilities(): unknown {
    return this.client.getServerCapabilities();
  }

  getServerVersion(): unknown {
    return this.client.getServerVersion();
  }

  sendRootsListChanged(): Promise<void> {
    return this.client.sendRootsListChanged();
  }

  setEvents(events: McpSdkClientEvents): void {
    this.events = events;
    this.client.fallbackNotificationHandler = events.onNotification;
    this.client.onerror = events.onError;
    this.client.onclose = events.onClose;
  }
}

function installClientRequestHandlers(client: Client, handlers: McpSdkClientRequestHandlers) {
  // The SDK validates request params and result envelopes for elicitation and
  // sampling; the handlers own the human round-trip and content validation.
  client.setRequestHandler(
    'elicitation/create',
    async (request, ctx) =>
      (await handlers.elicit(request.params, ctx.mcpReq.signal)) as ElicitResult
  );
  client.setRequestHandler(
    'sampling/createMessage',
    async (request, ctx) =>
      (await handlers.createMessage(request.params, ctx.mcpReq.signal)) as CreateMessageResult
  );
  client.setRequestHandler('roots/list', () => handlers.listRoots());
}

export async function connectMcpSdkClient(options: McpSdkConnectOptions): Promise<McpSdkClient> {
  const client = new ResturaMcpSdkClient(options);
  options.onClientCreated?.(client);
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}
