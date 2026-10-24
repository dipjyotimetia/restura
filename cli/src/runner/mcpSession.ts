import {
  Client,
  ProtocolError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { JsonRpcError } from '@shared/protocol/mcp-proxy';
import type { McpRunReplyInput } from '@shared/protocol/mcp-run';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import {
  configuredProxyEnvironment,
  createPinnedLookup,
  isNoProxyDestination,
  resolvePinnedMcpAddress,
} from './pinnedMcpFetch.js';
import { type TlsOptions, tlsConnectOptions } from './undiciFetcher.js';

/**
 * One MCP session for `restura run` (#901), on the official SDK client: it
 * owns the initialize → notifications/initialized handshake, the
 * `Mcp-Session-Id`, SSE-framed replies and the legacy http-sse transport, so
 * the executor only sends the saved operation. The runner pools one session
 * per server for the whole run and closes them at the end.
 */
export interface CliMcpSession {
  request(
    method: string,
    params: unknown,
    options: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<McpRunReplyInput>;
  close(): Promise<void>;
}

export interface CliMcpSessionOptions {
  url: string;
  transport: 'streamable-http' | 'http-sse';
  /** Already sanitised by `validateMcpSpec`. */
  headers: Record<string, string>;
  allowLocalhost: boolean;
  timeoutMs: number;
  /**
   * Run-level dispatcher. Used only when an explicit `proxy` is set (the proxy
   * dials the origin, so the connection cannot be pinned); otherwise the
   * session builds its own DNS-pinned agent from `tls`.
   */
  dispatcher?: Dispatcher;
  /** TLS options applied to the DNS-pinned direct connection. */
  tls?: TlsOptions;
  /** Explicit `--proxy`: connections go via `dispatcher`, pre-flight guard only. */
  proxy?: string;
  /** Test seam: remap the validated IP actually dialled. Never set in production. */
  dialAddress?: (validatedIp: string) => string;
  signal?: AbortSignal;
}

// Raw results: the test script asserts on exactly what the server sent.
const ANY_RESULT = z.unknown();
// The SDK sets these itself; a second copy would only conflict.
const SDK_OWNED_HEADERS = new Set(['content-type', 'accept']);

/**
 * Cap on bytes read from any one MCP response (a JSON reply, or the whole of
 * an SSE stream). Same ceiling as the desktop HTTP body limit.
 */
export const MAX_MCP_RESPONSE_BYTES = 50 * 1024 * 1024;

function byteCap(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error(`MCP response exceeds ${maxBytes} byte cap`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export type GuardedMcpFetch = typeof globalThis.fetch & { dispose(): Promise<void> };

/**
 * Every URL the SDK touches (incl. the POST endpoint a legacy SSE server
 * announces, and the terminating DELETE) passes the CLI's DNS pre-flight SSRF
 * guard (`resolvePinnedMcpAddress`: literal + every resolved record checked).
 * Redirects are refused without following `Location`, and response bodies
 * are bounded.
 */
export function createGuardedMcpFetch(
  options: Pick<
    CliMcpSessionOptions,
    'allowLocalhost' | 'dispatcher' | 'tls' | 'proxy' | 'dialAddress'
  >,
  maxBytes = MAX_MCP_RESPONSE_BYTES
): GuardedMcpFetch {
  const agents = new Map<string, Agent>();
  let disposed = false;
  // One pinned agent per validated (host, ip); a rebinding host gets a new
  // agent, never a reused connection to the previous address.
  const agentFor = (host: string, ip: string): Agent => {
    const key = `${host}|${ip}`;
    let agent = agents.get(key);
    if (!agent) {
      agent = new Agent({
        connect: {
          ...tlsConnectOptions(options.tls),
          lookup: createPinnedLookup(host, options.dialAddress ? options.dialAddress(ip) : ip),
        } as Agent.Options['connect'],
      });
      agents.set(key, agent);
    }
    return agent;
  };
  const guarded = (async (input, init) => {
    if (disposed) throw new DOMException('MCP session disposed', 'AbortError');
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const address = await resolvePinnedMcpAddress(rawUrl, options.allowLocalhost);
    // Behind a proxy (explicit --proxy, or HTTP(S)_PROXY with no custom
    // dispatcher) the proxy resolves the origin, so pinning is impossible and
    // only the pre-flight check above applies. Otherwise dial ONLY the
    // validated IP (no second DNS lookup), keeping the hostname for SNI/Host.
    const viaProxy =
      Boolean(options.proxy) ||
      (!options.dispatcher &&
        Boolean(configuredProxyEnvironment()) &&
        !isNoProxyDestination(rawUrl));
    const dispatcher = viaProxy ? options.dispatcher : agentFor(address.host, address.ip);
    const response = await undiciFetch(rawUrl, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      ...(dispatcher ? { dispatcher } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error(
        `MCP server redirected (HTTP ${response.status}); redirects are not followed`
      );
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new Error(`MCP response exceeds ${maxBytes} byte cap`);
    }
    if (!response.body) return response as unknown as Response;
    return new Response(
      (response.body as unknown as ReadableStream<Uint8Array>).pipeThrough(byteCap(maxBytes)),
      {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
      }
    );
  }) as typeof globalThis.fetch;
  return Object.assign(guarded, {
    async dispose() {
      disposed = true;
      const open = [...agents.values()];
      agents.clear();
      await Promise.allSettled(open.map((a) => a.close()));
    },
  });
}

function toJsonRpcError(err: ProtocolError): JsonRpcError {
  return {
    code: err.code,
    message: err.message.replace(/^MCP error -?\d+:\s*/, ''),
    ...(err.data !== undefined ? { data: err.data } : {}),
  };
}

export async function openCliMcpSession(options: CliMcpSessionOptions): Promise<CliMcpSession> {
  const headers = Object.fromEntries(
    Object.entries(options.headers).filter(([k]) => !SDK_OWNED_HEADERS.has(k.toLowerCase()))
  );
  const guardedFetch = createGuardedMcpFetch(options);
  const transportOptions = { fetch: guardedFetch, requestInit: { headers } };
  const transport =
    options.transport === 'http-sse'
      ? new SSEClientTransport(new URL(options.url), transportOptions)
      : new StreamableHTTPClientTransport(new URL(options.url), transportOptions);
  const client = new Client(
    { name: 'restura-cli', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } }
  );
  try {
    await client.connect(transport, {
      timeout: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    await client.close().catch(() => {});
    await guardedFetch.dispose();
    throw err;
  }

  return {
    async request(method, params, { timeoutMs, signal }) {
      // The SDK already ran initialize during connect; report its outcome
      // instead of sending a second (spec-violating) initialize.
      if (method === 'initialize') {
        return {
          result: {
            protocolVersion: client.getNegotiatedProtocolVersion(),
            capabilities: client.getServerCapabilities(),
            serverInfo: client.getServerVersion(),
          },
        };
      }
      try {
        const result = await client.request(
          { method, ...(params !== undefined ? { params } : {}) } as Parameters<
            Client['request']
          >[0],
          ANY_RESULT,
          { timeout: timeoutMs, ...(signal ? { signal } : {}) }
        );
        return { result };
      } catch (err) {
        // A JSON-RPC error the server sent is an outcome scripts can assert
        // on; anything else (timeout, HTTP, transport) is a failure.
        if (err instanceof ProtocolError) return { error: toJsonRpcError(err) };
        throw err;
      }
    },
    async close() {
      if (transport instanceof StreamableHTTPClientTransport) {
        await transport.terminateSession().catch(() => {});
      }
      await client.close().catch(() => {});
      await guardedFetch.dispose();
    },
  };
}

/**
 * Run-scoped session pool keyed by resolved server identity. Concurrent
 * callers for the same key share one in-flight connect; a failed connect is
 * evicted so a later item can retry.
 */
export class CliMcpSessionPool {
  private readonly sessions = new Map<string, Promise<CliMcpSession>>();

  get(key: string, open: () => Promise<CliMcpSession>): Promise<CliMcpSession> {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = open();
    this.sessions.set(key, pending);
    pending.catch(() => {
      if (this.sessions.get(key) === pending) this.sessions.delete(key);
    });
    return pending;
  }

  /**
   * Drop (and close) a session after a transport-level failure so a retry or
   * a later item reconnects instead of reusing a broken session.
   */
  evict(key: string): void {
    const pending = this.sessions.get(key);
    if (!pending) return;
    this.sessions.delete(key);
    void pending.then((s) => s.close()).catch(() => {});
  }

  async dispose(): Promise<void> {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(pending.map(async (p) => (await p).close()));
  }
}
