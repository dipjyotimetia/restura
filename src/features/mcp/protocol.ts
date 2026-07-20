/**
 * MCP (Model Context Protocol) protocol module.
 *
 * - `runRequest` still throws — the interactive UI drives a long-lived
 *   McpClient via useMcpStore.
 * - `runJsonRpc` is the reusable single-call surface. It
 *   accepts an optional `clientPool` keyed by an executor-supplied
 *   `cacheKey` (typically a saved-resource id). When the pool has a
 *   cached client, it reuses it and skips the initialize handshake;
 *   otherwise it lazy-inits and caches. The executor disposes pooled
 *   clients in its run-end `finally`.
 *
 * Without the pool, a sequence of calls against the same
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
  /**
   * Look up a cached (possibly still-connecting) client. Storing the
   * *promise* rather than the resolved client is load-bearing: it lets a
   * second concurrent `mcpCall` with the same `cacheKey` await the SAME
   * in-flight `connect`+`initialize` instead of racing its own — a plain
   * get-then-set here would otherwise let two concurrent callers both see
   * `undefined`, both create+init a client, and have the second `set()`
   * silently orphan the first (never disconnected).
   */
  get(key: string): Promise<McpClient> | undefined;
  /** Cache a client (or its in-flight init) under `key`. */
  set(key: string, client: Promise<McpClient>): void;
  /** Evict a cached entry — used to un-poison the pool after a failed init. */
  delete(key: string): void;
}

class McpInitError extends Error {
  jsonRpcError?: JsonRpcCallResult['jsonRpcError'];
  constructor(message: string, jsonRpcError?: JsonRpcCallResult['jsonRpcError']) {
    super(message);
    this.name = 'McpInitError';
    if (jsonRpcError) this.jsonRpcError = jsonRpcError;
  }
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

async function initializeClient(
  client: McpClient
): Promise<
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

/** Build + connect + initialize a fresh client. Throws `McpInitError` on
 *  failure rather than returning a result object, so it composes cleanly
 *  as a cacheable `Promise<McpClient>` in the pool (a rejected promise
 *  naturally clears itself; see the `.catch` below). */
async function createAndInitClient(mcp: McpRequest, method: string): Promise<McpClient> {
  const headerMap: Record<string, string> = {};
  for (const h of mcp.headers ?? []) {
    if (h.enabled !== false && h.key) headerMap[h.key] = h.value;
  }
  const client = new McpClient({
    url: mcp.url,
    transport: mcp.transport,
    headers: headerMap,
    connectionId: `flow-${uuidv4()}`,
  });
  // Skip the explicit initialize step when the caller asked for
  // `initialize` themselves.
  if (method !== 'initialize') {
    const init = await initializeClient(client);
    if (!init.ok) throw new McpInitError(init.error, init.jsonRpcError);
  } else {
    const conn = await client.connect();
    if (!conn.ok) throw new McpInitError(conn.error);
  }
  return client;
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
  const pool = opts.clientPool;
  const cacheKey = opts.cacheKey;

  let ownsClient = false;
  let clientPromise = pool && cacheKey ? pool.get(cacheKey) : undefined;
  if (!clientPromise) {
    // Create + register the promise synchronously (no `await` before
    // `pool.set`) so a concurrent `mcpCall` with the same cacheKey that
    // calls `pool.get` right after sees THIS in-flight init and awaits
    // it too, instead of racing to create its own client.
    clientPromise = createAndInitClient(mcp, opts.method);
    if (pool && cacheKey) {
      pool.set(cacheKey, clientPromise);
      // Don't let a failed init permanently poison the pool for later,
      // unrelated calls — evict it, but only if we're still the cached
      // entry (a newer successful attempt may have already replaced us).
      clientPromise.catch(() => {
        if (pool.get(cacheKey) === clientPromise) pool.delete(cacheKey);
      });
    } else {
      ownsClient = true;
    }
  }

  let client: McpClient;
  try {
    client = await clientPromise;
  } catch (err) {
    if (err instanceof McpInitError) {
      return err.jsonRpcError
        ? { ok: false, error: err.message, jsonRpcError: err.jsonRpcError }
        : { ok: false, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
