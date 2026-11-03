/**
 * Restura MCP control server — the loopback streamable-HTTP listener and the
 * MCP tool surface (ADR 0041). Electron-free: the IPC bridge to the renderer
 * is injected as a `ControlToolDispatcher`, so the whole listener (auth,
 * origin policy, rate limit, SDK wiring) is exercised in Vitest with a real
 * MCP client.
 *
 * Every tool in `CONTROL_TOOLS` is registered with its title, description,
 * input schema and annotations. The SDK validates arguments against the
 * schema before the callback runs; the dispatcher (renderer) validates again
 * and applies consent + approval. Output is deep-redacted here once more
 * before it reaches the agent.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { CLIENT_INFO_META_KEY, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  CONTROL_SERVER_PATH,
  type ControlToolResult,
  type ToolCallClient,
} from '@shared/mcp-server/control-bridge';
import {
  CONTROL_SERVER_INSTRUCTIONS,
  CONTROL_TOOLS,
  type ControlToolAnnotations,
} from '@shared/mcp-server/control-tools';
import { redactSecretsDeep } from '@shared/mcp-server/redaction';
import { createLogger } from '@shared/runtime/logger';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { clientLabelFromHeaders, isAuthorized, rejectControlRequest } from './mcp-control-protocol';

const log = createLogger('mcp-control');

export interface ControlToolCall {
  tool: string;
  input: unknown;
  client?: ToolCallClient;
  signal: AbortSignal;
}

/** Runs one tool call (in production: forwards to the renderer and waits). */
export type ControlToolDispatcher = (call: ControlToolCall) => Promise<ControlToolResult>;

export interface CallToolContent {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Map a tool result onto MCP `CallToolResult` content. */
export function toolResultToContent(result: ControlToolResult): CallToolContent {
  if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
  // Belt-and-braces: renderer tools redact already; this catches any tool that forgets.
  const data = redactSecretsDeep(result.data);
  return { content: [{ type: 'text', text: JSON.stringify(data ?? null, null, 2) }] };
}

export interface ControlServerIdentity {
  name: string;
  version: string;
}

/** Answers one tool call with MCP content (the HTTP server and the stdio shim differ here). */
export type ControlToolContentHandler = (call: ControlToolCall) => Promise<CallToolContent>;

/**
 * Register the control catalogue on an MCP server. `getClient` resolves the
 * (display-only) caller label for the activity log.
 */
export function registerControlTools(
  server: McpServer,
  handle: ControlToolContentHandler,
  getClient: () => ToolCallClient | undefined
): void {
  for (const tool of CONTROL_TOOLS) {
    // The registerTool overloads cannot narrow a heterogeneous union of input
    // schemas inside this loop. The SDK still validates the arguments against
    // `inputSchema` (and the renderer re-validates), so the overload choice is
    // not load-bearing — call through a permissive signature.
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      config: {
        title: string;
        description: string;
        inputSchema: unknown;
        annotations: ControlToolAnnotations;
      },
      cb: (
        args: unknown,
        ctx: { mcpReq: { signal: AbortSignal; _meta?: Record<string, unknown> } }
      ) => Promise<CallToolContent>
    ) => void;
    register(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args, ctx) => {
        // 2026-07-28-era clients send their initialize identity on every
        // request; prefer it to the transport-level guess.
        const client = clientFromMeta(ctx.mcpReq._meta) ?? getClient();
        return handle({
          tool: tool.name,
          input: args ?? {},
          ...(client ? { client } : {}),
          signal: ctx.mcpReq.signal,
        });
      }
    );
  }
}

/** The `io.modelcontextprotocol/clientInfo` request meta, when well-formed. */
export function clientFromMeta(
  meta: Record<string, unknown> | undefined
): ToolCallClient | undefined {
  const info = meta?.[CLIENT_INFO_META_KEY];
  if (!info || typeof info !== 'object') return undefined;
  const { name, version } = info as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || name.trim() === '') return undefined;
  const clean = (v: string) =>
    v
      .replace(/[^\x20-\x7e]/g, '')
      .trim()
      .slice(0, 120);
  return {
    name: clean(name),
    ...(typeof version === 'string' && version ? { version: clean(version).slice(0, 40) } : {}),
  };
}

/** A fresh control server instance whose tools answer through `handle`. */
export function createControlMcpServer(
  identity: ControlServerIdentity,
  handle: ControlToolContentHandler,
  getClient: (server: McpServer) => ToolCallClient | undefined = () => undefined
): McpServer {
  const server = new McpServer(
    { name: identity.name, version: identity.version },
    { instructions: CONTROL_SERVER_INSTRUCTIONS, capabilities: { tools: {} } }
  );
  registerControlTools(server, handle, () => getClient(server));
  return server;
}

/** Adapt a result-shaped dispatcher to MCP content. */
export function contentHandlerFor(dispatch: ControlToolDispatcher): ControlToolContentHandler {
  return async (call) => toolResultToContent(await dispatch(call));
}

// ---------------------------------------------------------------------------
// Loopback HTTP listener
// ---------------------------------------------------------------------------

/** How long close() lets in-flight responses flush before cutting sockets. */
const CLOSE_DRAIN_MS = 1_000;

/** Largest request body the listener parses (import_collection documents). */
export const MAX_CONTROL_REQUEST_BYTES = 24 * 1024 * 1024;

/** Requests per minute the listener accepts (all clients together). */
export const CONTROL_HTTP_RATE_LIMIT = 600;

export interface ControlHttpServerOptions {
  identity: ControlServerIdentity;
  /** Returns the current bearer token ('' → every request is refused). */
  getToken: () => string;
  dispatch: ControlToolDispatcher;
  /** Try this port first; fall back to an ephemeral one if it is taken. */
  preferredPort?: number;
  /** Called after each authenticated request (status / activity timestamps). */
  onAuthenticatedRequest?: () => void;
  rateLimit?: number;
}

export interface ControlHttpServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

function reply(res: http.ServerResponse, status: number, body: unknown, extra = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startControlHttpServer(
  options: ControlHttpServerOptions
): Promise<ControlHttpServerHandle> {
  const limiter = createKeyedRateLimiter(options.rateLimit ?? CONTROL_HTTP_RATE_LIMIT, 60_000);

  const handler = createMcpHandler(
    ({ requestInfo }) => {
      const label = requestInfo
        ? clientLabelFromHeaders(Object.fromEntries(requestInfo.headers.entries()))
        : undefined;
      return createControlMcpServer(options.identity, contentHandlerFor(options.dispatch), () =>
        label ? { name: label } : undefined
      );
    },
    {
      onerror: (error) => log.warn('control server request error', { message: error.message }),
      // Sized for the largest import_collection document plus JSON escaping;
      // anything bigger is answered 413 before it is parsed.
      maxRequestBodySize: MAX_CONTROL_REQUEST_BYTES,
    }
  );
  const nodeHandler = toNodeHandler(handler);

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== CONTROL_SERVER_PATH) {
      reply(res, 404, { error: 'not found' });
      return;
    }
    const rejection = rejectControlRequest(req.headers);
    if (rejection) {
      log.warn('control server refused request', { reason: rejection });
      reply(res, 403, { error: 'forbidden' });
      return;
    }
    if (!isAuthorized(req.headers, options.getToken())) {
      reply(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="restura"' });
      return;
    }
    if (!limiter.check('all')) {
      reply(res, 429, { error: 'rate limit exceeded' }, { 'retry-after': '60' });
      return;
    }
    options.onAuthenticatedRequest?.();
    void nodeHandler(req, res).catch((err: unknown) => {
      log.error('control server handler failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
    });
  });
  // Slow-loris guards: `requestTimeout` bounds *receiving* the request (headers
  // + body). Approval waits happen after the body is read, while the response
  // is pending, so they are not cut off by it (TOOL_CALL_TIMEOUT_MS bounds them).
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  let port: number;
  try {
    port = await listen(server, options.preferredPort ?? 0);
  } catch (err) {
    if (options.preferredPort && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log.warn('preferred control port in use, using an ephemeral port', {
        port: options.preferredPort,
      });
      port = await listen(server, 0);
    } else {
      throw err;
    }
  }

  return {
    port,
    url: `http://127.0.0.1:${port}${CONTROL_SERVER_PATH}`,
    close: async () => {
      await handler.close().catch(() => undefined);
      // Stop accepting, drop idle keep-alive sockets, then give in-flight
      // responses (e.g. the "server was turned off" error for a parked call)
      // a moment to flush before forcing the rest closed.
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), CLOSE_DRAIN_MS);
        force.unref?.();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}
