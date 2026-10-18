import {
  Client,
  type ClientNotification,
  type ClientRequest,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import type { TrackedChild } from './mcp-stdio-session';

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
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notification(method: string, params: unknown): Promise<void>;
  getProtocolVersion(): string;
  getServerCapabilities(): unknown;
  getServerVersion(): unknown;
  setEvents(events: McpSdkClientEvents): void;
}

interface McpSdkConnectCommon {
  events?: McpSdkClientEvents;
  onClientCreated?: (client: McpSdkClient) => void;
}

export type McpSdkConnectOptions =
  | (McpSdkConnectCommon & {
      url: URL;
      transport: McpSdkTransport;
      transportOptions: McpSdkTransportOptions;
    })
  | (McpSdkConnectCommon & { transport: 'stdio'; stdio: McpSdkStdioParams });

const CLIENT_INFO = { name: 'restura', version: '1.0.0' };
// Standard MCP methods are dispatched through the SDK's typed APIs below.
// The renderer may also inspect a server extension. v2 requires an explicit
// result schema for that opt-in path so a remote JSON-RPC error still reaches
// the caller instead of failing local request validation.
const EXTENSION_RESULT_SCHEMA = z.unknown();

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

  constructor(options: McpSdkConnectOptions) {
    if (options.transport === 'stdio') {
      this.transport = createStdioTransport(options.stdio);
      // stdio uses the plain `initialize` handshake. `auto` negotiation would
      // spawn a hidden second copy of the server (the SDK's disposable
      // "sibling" probe) — an extra, untracked launch of a user-approved
      // command whose stderr is discarded. One consented launch, one process.
      this.client = new Client(CLIENT_INFO, {
        capabilities: {},
        versionNegotiation: { mode: 'legacy' },
      });
    } else {
      this.transport =
        options.transport === 'streamable-http'
          ? new StreamableHTTPClientTransport(options.url, options.transportOptions)
          : new SSEClientTransport(options.url, options.transportOptions);
      this.client = new Client(CLIENT_INFO, {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
      });
    }
    if (options.events) this.setEvents(options.events);
  }

  connect(): Promise<void> {
    return this.client.connect(this.transport);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  async terminateSession(): Promise<void> {
    if (this.transport instanceof StreamableHTTPClientTransport) {
      await this.transport.terminateSession();
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const options = { timeout: timeoutMs };
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
        return this.client.callTool(params as Parameters<Client['callTool']>[0], options);
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
        return this.client.subscribeResource(
          params as Parameters<Client['subscribeResource']>[0],
          options
        );
      case 'resources/unsubscribe':
        return this.client.unsubscribeResource(
          params as Parameters<Client['unsubscribeResource']>[0],
          options
        );
      case 'prompts/list':
        return this.client.listPrompts(params as Parameters<Client['listPrompts']>[0], options);
      case 'prompts/get':
        return this.client.getPrompt(params as Parameters<Client['getPrompt']>[0], options);
      default:
        return this.client.request({ method, params } as ClientRequest, EXTENSION_RESULT_SCHEMA, {
          timeout: timeoutMs,
        });
    }
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

  setEvents(events: McpSdkClientEvents): void {
    this.client.fallbackNotificationHandler = events.onNotification;
    this.client.onerror = events.onError;
    this.client.onclose = events.onClose;
  }
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
