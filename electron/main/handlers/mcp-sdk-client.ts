import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport as V1SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport as V1StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  type ClientNotification as V1ClientNotification,
  type ClientRequest as V1ClientRequest,
  ResultSchema as V1ResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Client as V2Client,
  SSEClientTransport as V2SSEClientTransport,
  StreamableHTTPClientTransport as V2StreamableHTTPClientTransport,
  type ClientNotification as V2ClientNotification,
  type ClientRequest as V2ClientRequest,
} from '@modelcontextprotocol/client';
import { z } from 'zod';

export type McpSdkVersion = 'v1' | 'v2';
export type McpSdkTransport = 'streamable-http' | 'http-sse';

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
  readonly sdkVersion: McpSdkVersion;
  connect(): Promise<void>;
  close(): Promise<void>;
  terminateSession(): Promise<void>;
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notification(method: string, params: unknown): Promise<void>;
  getProtocolVersion(): string | undefined;
  getServerCapabilities(): unknown;
  getServerVersion(): unknown;
  setEvents(events: McpSdkClientEvents): void;
}

export interface McpSdkConnectOptions {
  url: URL;
  transport: McpSdkTransport;
  transportOptions: McpSdkTransportOptions;
  events?: McpSdkClientEvents;
  onClientCreated?: (client: McpSdkClient) => void;
  isCancelled?: () => boolean;
}

const CLIENT_INFO = { name: 'restura', version: '1.0.0' };
// Standard MCP methods are dispatched through the SDK's typed APIs below.
// The renderer may also inspect a server extension. v2 requires an explicit
// result schema for that opt-in path so a remote JSON-RPC error still reaches
// the caller instead of failing local request validation.
const V2ExtensionResultSchema = z.unknown();

abstract class BaseMcpSdkClient implements McpSdkClient {
  abstract readonly sdkVersion: McpSdkVersion;
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract terminateSession(): Promise<void>;
  abstract request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  abstract notification(method: string, params: unknown): Promise<void>;
  abstract getProtocolVersion(): string | undefined;
  abstract getServerCapabilities(): unknown;
  abstract getServerVersion(): unknown;
  abstract setEvents(events: McpSdkClientEvents): void;
}

class V1McpSdkClient extends BaseMcpSdkClient {
  readonly sdkVersion = 'v1' as const;
  private readonly transport: V1StreamableHTTPClientTransport | V1SSEClientTransport;
  private readonly client = new V1Client(CLIENT_INFO, { capabilities: {} });

  constructor(options: McpSdkConnectOptions) {
    super();
    this.transport =
      options.transport === 'streamable-http'
        ? new V1StreamableHTTPClientTransport(options.url, options.transportOptions)
        : new V1SSEClientTransport(options.url, options.transportOptions);
    if (options.events) this.setEvents(options.events);
  }

  connect(): Promise<void> {
    return this.client.connect(this.transport);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  async terminateSession(): Promise<void> {
    if (this.transport instanceof V1StreamableHTTPClientTransport) {
      await this.transport.terminateSession();
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const options = { timeout: timeoutMs };
    switch (method) {
      case 'ping':
        return this.client.ping(options);
      case 'completion/complete':
        return this.client.complete(params as Parameters<V1Client['complete']>[0], options);
      case 'logging/setLevel':
        return this.client.setLoggingLevel(
          (params as { level: Parameters<V1Client['setLoggingLevel']>[0] }).level,
          options
        );
      case 'tools/list':
        return this.client.listTools(params as Parameters<V1Client['listTools']>[0], options);
      case 'tools/call':
        return this.client.callTool(
          params as Parameters<V1Client['callTool']>[0],
          undefined,
          options
        );
      case 'resources/list':
        return this.client.listResources(
          params as Parameters<V1Client['listResources']>[0],
          options
        );
      case 'resources/templates/list':
        return this.client.listResourceTemplates(
          params as Parameters<V1Client['listResourceTemplates']>[0],
          options
        );
      case 'resources/read':
        return this.client.readResource(params as Parameters<V1Client['readResource']>[0], options);
      case 'resources/subscribe':
        return this.client.subscribeResource(
          params as Parameters<V1Client['subscribeResource']>[0],
          options
        );
      case 'resources/unsubscribe':
        return this.client.unsubscribeResource(
          params as Parameters<V1Client['unsubscribeResource']>[0],
          options
        );
      case 'prompts/list':
        return this.client.listPrompts(params as Parameters<V1Client['listPrompts']>[0], options);
      case 'prompts/get':
        return this.client.getPrompt(params as Parameters<V1Client['getPrompt']>[0], options);
      default:
        return this.client.request({ method, params } as V1ClientRequest, V1ResultSchema, options);
    }
  }

  notification(method: string, params: unknown): Promise<void> {
    return this.client.notification({ method, params } as V1ClientNotification);
  }

  getProtocolVersion(): string | undefined {
    return this.transport instanceof V1StreamableHTTPClientTransport
      ? this.transport.protocolVersion
      : undefined;
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

class V2McpSdkClient extends BaseMcpSdkClient {
  readonly sdkVersion = 'v2' as const;
  private readonly transport: V2StreamableHTTPClientTransport | V2SSEClientTransport;
  private readonly client = new V2Client(CLIENT_INFO, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
  });

  constructor(options: McpSdkConnectOptions) {
    super();
    this.transport =
      options.transport === 'streamable-http'
        ? new V2StreamableHTTPClientTransport(options.url, options.transportOptions)
        : new V2SSEClientTransport(options.url, options.transportOptions);
    if (options.events) this.setEvents(options.events);
  }

  connect(): Promise<void> {
    return this.client.connect(this.transport);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  async terminateSession(): Promise<void> {
    if (this.transport instanceof V2StreamableHTTPClientTransport) {
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
        return this.client.complete(params as Parameters<V2Client['complete']>[0], options);
      case 'logging/setLevel':
        return this.client.setLoggingLevel(
          (params as { level: Parameters<V2Client['setLoggingLevel']>[0] }).level,
          options
        );
      case 'tools/list':
        return this.client.listTools(params as Parameters<V2Client['listTools']>[0], options);
      case 'tools/call':
        return this.client.callTool(params as Parameters<V2Client['callTool']>[0], options);
      case 'resources/list':
        return this.client.listResources(
          params as Parameters<V2Client['listResources']>[0],
          options
        );
      case 'resources/templates/list':
        return this.client.listResourceTemplates(
          params as Parameters<V2Client['listResourceTemplates']>[0],
          options
        );
      case 'resources/read':
        return this.client.readResource(params as Parameters<V2Client['readResource']>[0], options);
      case 'resources/subscribe':
        return this.client.subscribeResource(
          params as Parameters<V2Client['subscribeResource']>[0],
          options
        );
      case 'resources/unsubscribe':
        return this.client.unsubscribeResource(
          params as Parameters<V2Client['unsubscribeResource']>[0],
          options
        );
      case 'prompts/list':
        return this.client.listPrompts(params as Parameters<V2Client['listPrompts']>[0], options);
      case 'prompts/get':
        return this.client.getPrompt(params as Parameters<V2Client['getPrompt']>[0], options);
      default:
        return this.client.request({ method, params } as V2ClientRequest, V2ExtensionResultSchema, {
          timeout: timeoutMs,
        });
    }
  }

  notification(method: string, params: unknown): Promise<void> {
    return this.client.notification({ method, params } as V2ClientNotification);
  }

  getProtocolVersion(): string | undefined {
    return this.transport instanceof V2StreamableHTTPClientTransport
      ? this.transport.protocolVersion
      : undefined;
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

function createMcpSdkClient(
  options: McpSdkConnectOptions,
  sdkVersion: McpSdkVersion
): McpSdkClient {
  return sdkVersion === 'v2' ? new V2McpSdkClient(options) : new V1McpSdkClient(options);
}

function errorNumber(error: unknown, key: 'code' | 'status'): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

/** Only protocol/transport incompatibilities earn a v1 retry. */
export function isMcpProtocolCompatibilityError(error: unknown): boolean {
  const code = errorNumber(error, 'code');
  if (code === -32601 || code === -32022) return true;

  const status = errorNumber(error, 'status');
  return status === 404 || status === 405 || status === 415 || status === 426;
}

async function closeAfterFailedConnect(client: McpSdkClient): Promise<void> {
  await client.close().catch(() => undefined);
}

/**
 * Connect with the v2 client first. v2 already negotiates modern versus legacy
 * protocol eras; v1 remains a narrow fallback for incompatible legacy stacks.
 */
export async function connectMcpSdkClient(options: McpSdkConnectOptions): Promise<McpSdkClient> {
  const v2 = createMcpSdkClient(options, 'v2');
  options.onClientCreated?.(v2);
  let v2Connected = false;
  try {
    await v2.connect();
    v2Connected = true;
  } catch (error) {
    await closeAfterFailedConnect(v2);
    if (!isMcpProtocolCompatibilityError(error)) throw error;
  }

  if (v2Connected) {
    return v2;
  }
  if (options.isCancelled?.()) throw new Error('Connection cancelled');

  const v1 = createMcpSdkClient(options, 'v1');
  options.onClientCreated?.(v1);
  try {
    await v1.connect();
  } catch (error) {
    await closeAfterFailedConnect(v1);
    throw error;
  }
  return v1;
}
