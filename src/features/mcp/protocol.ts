/**
 * MCP (Model Context Protocol) protocol module — metadata-only registration.
 *
 * MCP uses long-lived JSON-RPC sessions over either streamable-HTTP or
 * HTTP+SSE transports. The renderer talks to the server through `McpClient`
 * (see `lib/mcpClient.ts`), which is keyed by a stable `connectionId` and
 * surfaces a richer surface than `runRequest`'s single-shot
 * `Request -> Response` contract:
 *  - `initialize` exchange + capability discovery
 *  - per-method calls (`tools/call`, `resources/read`, `prompts/get`, ...)
 *  - server-pushed events on the SSE channel
 *
 * Migrating that lifecycle into the registry's runner would require
 * extending `RunContext` with session state and a streaming sink for
 * server pushes. That work is tracked separately. For now this module
 * exists so the registry has a complete catalog of supported protocols
 * (used by the mode picker and future code-generators) — `runRequest`
 * intentionally throws to point future callers at the proper API.
 */
import { v4 as uuidv4 } from 'uuid';
import type { ProtocolModule } from '@/features/registry/types';
import type { McpRequest } from '@/types';

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

export const mcpProtocol: ProtocolModule = {
  id: 'mcp',
  label: 'MCP',
  tabType: 'mcp',
  defaultRequest: createDefaultMcpRequest,
  // TODO(registry-streaming): MCP needs session lifecycle (initialize,
  // tools/list, tools/call, server-push) which today's runRequest contract
  // doesn't model. McpRequestBuilder drives the McpClient directly via the
  // useMcpStore connection map. Once RunContext supports session state and
  // a server-event sink, replace this stub with a wrapper that opens a
  // connection, calls request.defaultMethod with request.defaultParams,
  // and returns the JSON-RPC result as a Response.
  runRequest: async () => {
    throw new Error(
      'MCP runs through useMcpStore + McpClient (session-based JSON-RPC); ' +
        'use the McpRequestBuilder, not the registry runner.'
    );
  },
};
