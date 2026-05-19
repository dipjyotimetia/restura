/**
 * MCP (Model Context Protocol) protocol module.
 *
 * - `runRequest` still throws — the interactive UI drives a long-lived
 *   McpClient via useMcpStore.
 * - `runJsonRpc` is the graph-executor-facing single-call surface. It
 *   accepts an optional `clientPool` keyed by an executor-supplied
 *   `cacheKey` (typically the WorkflowRequest id). When the pool has a
 *   cached client, it reuses it and skips the initialize handshake;
 *   otherwise it lazy-inits and caches. The executor disposes pooled
 *   clients in its run-end `finally`.
 *
 * Without the pool, a workflow with N mcpCall nodes against the same
 * server pays N initialize round-trips. With the pool, one.
 */
import { v4 as uuidv4 } from 'uuid';
import type { ProtocolModule } from '@/features/registry/types';
import type { McpRequest, Request } from '@/types';
import { McpClient } from './lib/mcpClient';

function createDefaultMcpRequest(): McpRequest {
  return {
    id: uuidv4(),
    name: 'New MCP Request',
    type: 'mcp',
    url: '',
    transport: 'streamable-http',
    headers: [],
    auth: { type: 'none' },
  };
}

interface JsonRpcCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  jsonRpcError?: { code: number; message: string; data?: unknown };
}

export interface McpClientPool {
  /** Look up a cached client. */
  get(key: string): McpClient | undefined;
  /** Cache a client under `key`. */
  set(key: string, client: McpClient): void;
}

export interface McpRunJsonRpcOptions {
  method: string;
  params?: unknown;
  /** When provided alongside `cacheKey`, the protocol reuses a cached
   *  client (skipping `initialize`) or lazy-inits + caches if absent.
   *  The executor must dispose pooled clients itself. */
  clientPool?: McpClientPool;
  cacheKey?: string;
}

async function initializeClient(client: McpClient): Promise<
  { ok: true } | { ok: false; error: string; jsonRpcError?: JsonRpcCallResult['jsonRpcError'] }
> {
  const conn = await client.connect();
  if (!conn.ok) return { ok: false, error: conn.error };
  const init = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'restura-graph-executor', version: '0.1.0' },
  });
  if (!init.ok) {
    return {
      ok: false,
      error: `MCP initialize failed: ${init.error}`,
      ...(init.jsonRpcError ? { jsonRpcError: init.jsonRpcError } : {}),
    };
  }
  return { ok: true };
}

async function mcpRunJsonRpc(
  request: Request,
  ctx: { signal: AbortSignal },
  opts: McpRunJsonRpcOptions
): Promise<JsonRpcCallResult> {
  if (request.type !== 'mcp') {
    return { ok: false, error: `MCP runJsonRpc cannot run ${request.type} request` };
  }
  if (ctx.signal.aborted) {
    return { ok: false, error: 'Aborted before MCP call' };
  }

  const mcp = request as McpRequest;
  const pooled = opts.clientPool && opts.cacheKey
    ? opts.clientPool.get(opts.cacheKey)
    : undefined;

  let client = pooled;
  let ownsClient = false;
  if (!client) {
    const headerMap: Record<string, string> = {};
    for (const h of mcp.headers ?? []) {
      if (h.enabled !== false && h.key) headerMap[h.key] = h.value;
    }
    client = new McpClient({
      url: mcp.url,
      transport: mcp.transport,
      headers: headerMap,
      connectionId: `flow-${uuidv4()}`,
    });
    // Skip the explicit initialize step when the caller asked for
    // `initialize` themselves.
    if (opts.method !== 'initialize') {
      const init = await initializeClient(client);
      if (!init.ok) {
        return init.jsonRpcError
          ? { ok: false, error: init.error, jsonRpcError: init.jsonRpcError }
          : { ok: false, error: init.error };
      }
    } else {
      const conn = await client.connect();
      if (!conn.ok) return { ok: false, error: conn.error };
    }
    if (opts.clientPool && opts.cacheKey) {
      opts.clientPool.set(opts.cacheKey, client);
    } else {
      ownsClient = true;
    }
  }

  const linkAbort = () => {
    // Only tear down clients we own — pooled clients are the executor's
    // responsibility to dispose at run end.
    if (ownsClient && client) client.disconnect().catch(() => undefined);
  };
  ctx.signal.addEventListener('abort', linkAbort, { once: true });

  try {
    const callResult = await client.request(opts.method, opts.params);
    if (!callResult.ok) {
      return callResult.jsonRpcError
        ? {
            ok: false,
            error: callResult.error,
            jsonRpcError: callResult.jsonRpcError,
          }
        : { ok: false, error: callResult.error };
    }
    return { ok: true, result: callResult.result };
  } finally {
    ctx.signal.removeEventListener('abort', linkAbort);
    if (ownsClient) {
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}

type McpProtocolModule = ProtocolModule & {
  runJsonRpc: typeof mcpRunJsonRpc;
};

export const mcpProtocol: McpProtocolModule = {
  id: 'mcp',
  label: 'MCP',
  tabType: 'mcp',
  defaultRequest: createDefaultMcpRequest,
  runRequest: async () => {
    throw new Error(
      'MCP runs through useMcpStore + McpClient (session-based JSON-RPC); ' +
        'use the McpRequestBuilder, not the registry runner.'
    );
  },
  runJsonRpc: mcpRunJsonRpc,
};
