/**
 * MCP (Model Context Protocol) protocol module.
 *
 * Two surfaces:
 *
 *  1. `runRequest` — still throws. The interactive MCP UI drives a
 *     long-lived `McpClient` keyed by connectionId, with capability
 *     discovery and per-method calls. That lifecycle is bigger than
 *     a single `Request → Response` round-trip.
 *
 *  2. `runJsonRpc` — a graph-executor-facing surface that opens a
 *     short-lived McpClient, performs ONE JSON-RPC call (`tools/call`,
 *     `resources/read`, etc.), and tears the client down. Used by the
 *     DAG executor's `mcpCall` node.
 *
 * v1: each `mcpCall` invocation opens its own McpClient. Reusing a
 * client across multiple `mcpCall` nodes that hit the same MCP server
 * within a single run is a follow-up (it would let users avoid paying
 * the initialize handshake N times).
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

async function mcpRunJsonRpc(
  request: Request,
  ctx: { signal: AbortSignal },
  opts: { method: string; params?: unknown }
): Promise<JsonRpcCallResult> {
  if (request.type !== 'mcp') {
    return { ok: false, error: `MCP runJsonRpc cannot run ${request.type} request` };
  }
  if (ctx.signal.aborted) {
    return { ok: false, error: 'Aborted before MCP call' };
  }

  const mcp = request as McpRequest;
  const headerMap: Record<string, string> = {};
  for (const h of mcp.headers ?? []) {
    if (h.enabled !== false && h.key) headerMap[h.key] = h.value;
  }

  const connectionId = `flow-${uuidv4()}`;
  const client = new McpClient({
    url: mcp.url,
    transport: mcp.transport,
    headers: headerMap,
    connectionId,
  });

  // Tear-down link to the abort signal so a Stop click teardown the
  // session promptly.
  const linkAbort = () => {
    client.disconnect().catch(() => undefined);
  };
  ctx.signal.addEventListener('abort', linkAbort, { once: true });

  try {
    const conn = await client.connect();
    if (!conn.ok) {
      return { ok: false, error: conn.error };
    }
    // The MCP protocol requires the `initialize` handshake before any
    // other calls. McpClient doesn't auto-init — invoke it explicitly
    // unless the caller asked for `initialize` themselves.
    if (opts.method !== 'initialize') {
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
    }

    const callResult = await client.request(opts.method, opts.params);
    if (!callResult.ok) {
      return {
        ok: false,
        error: callResult.error,
        ...(callResult.jsonRpcError ? { jsonRpcError: callResult.jsonRpcError } : {}),
      };
    }
    return { ok: true, result: callResult.result };
  } finally {
    ctx.signal.removeEventListener('abort', linkAbort);
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }
}

// `runJsonRpc` isn't on the base ProtocolModule interface — it's an
// MCP-specific addition. The DAG executor casts when it looks up the
// MCP module.
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
