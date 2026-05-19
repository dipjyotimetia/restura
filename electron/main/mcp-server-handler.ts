/**
 * Restura-as-MCP-server — Electron main-process handler.
 *
 * Wires the @modelcontextprotocol/sdk transport to the pure dispatcher in
 * src/features/mcp-server/dispatch.ts. The dispatcher is where validation,
 * consent gating, and redaction live; this file is just SDK glue.
 *
 * Lifecycle:
 *  - `startStdioMcpServer(getContext)` spawns an McpServer wired to stdio,
 *    suitable for being launched as a subprocess by Claude Desktop / Cursor.
 *    The headless-mode launcher (`restura --mcp-server`) drives this.
 *  - The handler holds no state of its own — every tool invocation calls
 *    `getContext()` for a fresh snapshot of collections / environments /
 *    history. This keeps the renderer/main split clean: main has no
 *    long-lived copy of user data.
 *
 * Caller responsibilities:
 *  - Provide `getContext()` that returns a `McpDispatchContext` snapshot.
 *    Read-only is fine — the dispatcher never mutates the input.
 *  - Decide WHEN to start the server (gated by user opt-in setting + the
 *    --mcp-server CLI flag). The handler doesn't auto-start on import.
 *
 * Security:
 *  - Stdio transport is parent-process-only — no network surface.
 *  - HTTP/SSE transport (future) binds 127.0.0.1 only, with a one-time token
 *    displayed in the settings UI.
 *  - Tool input is parsed against the same Zod schemas the unit tests verify.
 *  - Tool output passes through `postProcessResult` (deep redaction) before
 *    crossing back to the client.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  TOOLS,
  dispatchTool,
  postProcessResult,
  type McpDispatchContext,
  type ToolResult,
} from '../../src/features/mcp-server/dispatch';

export interface McpServerHandle {
  /** Stop the server and free the transport. Idempotent. */
  stop: () => Promise<void>;
  /** The SDK server instance, in case the host needs to register more tools. */
  server: McpServer;
}

export type ContextProvider = () => Promise<McpDispatchContext> | McpDispatchContext;

/**
 * Start an MCP server over stdio. The returned handle's `stop()` tears the
 * transport down cleanly. Throws if SDK transport setup fails.
 *
 * Idempotent at the caller level: track the handle and refuse a second
 * `startStdioMcpServer` call if one is already running (the SDK does not
 * multiplex two transports on the same stdio).
 */
export async function startStdioMcpServer(getContext: ContextProvider): Promise<McpServerHandle> {
  const server = new McpServer({
    name: 'restura',
    version: '0.1.0',
  });

  for (const tool of Object.values(TOOLS)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The SDK accepts a Zod shape (`ZodRawShapeCompat`) or a full Zod
        // schema (`AnySchema`). Our schemas are full ZodObjects, which the
        // SDK accepts via the AnySchema branch.
        inputSchema: tool.inputSchema as never,
      },
      async (rawInput: unknown) => {
        const ctx = await getContext();
        const result = postProcessResult(dispatchTool(tool.name, rawInput, ctx));
        return toolResultToContent(result);
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let stopped = false;
  return {
    server,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.close();
    },
  };
}

/**
 * Convert a `ToolResult` to the MCP SDK's tool-call response shape.
 *
 * The SDK expects `{ content: Array<{ type, text }>, isError?: boolean }`.
 * Errors become `isError: true` with the error text; successful results
 * are stringified as JSON.
 */
function toolResultToContent(result: ToolResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
  };
}
