import {
  Client,
  ProtocolError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { JsonRpcError } from '@shared/protocol/mcp-proxy';
import type { McpRunReplyInput } from '@shared/protocol/mcp-run';
import { validateURL } from '@shared/protocol/url-validation';
import { type Dispatcher, fetch as undiciFetch } from 'undici';
import { z } from 'zod';

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
  /** TLS / proxy dispatcher built once per run. */
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}

// Raw results: the test script asserts on exactly what the server sent.
const ANY_RESULT = z.unknown();
// The SDK sets these itself; a second copy would only conflict.
const SDK_OWNED_HEADERS = new Set(['content-type', 'accept']);

/**
 * Every URL the SDK touches (incl. the POST endpoint a legacy SSE server
 * announces) is checked against the shared SSRF guard, and redirects are
 * refused rather than followed to an unvalidated host.
 */
function guardedFetch(options: CliMcpSessionOptions): typeof globalThis.fetch {
  return (async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const checked = validateURL(rawUrl, { allowLocalhost: options.allowLocalhost });
    if (!checked.valid) throw new Error(`MCP URL rejected: ${checked.error}`);
    const response = await undiciFetch(rawUrl, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error(
        `MCP server redirected (HTTP ${response.status}); redirects are not followed`
      );
    }
    return response as unknown as Response;
  }) as typeof globalThis.fetch;
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
  const transportOptions = { fetch: guardedFetch(options), requestInit: { headers } };
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

  async dispose(): Promise<void> {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(pending.map(async (p) => (await p).close()));
  }
}
