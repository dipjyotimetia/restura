/**
 * Restura-as-MCP-server — Electron main-process handler.
 *
 * Wires the @modelcontextprotocol/server transport to the pure dispatcher in
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

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  dispatchTool,
  type McpDispatchContext,
  postProcessResult,
  TOOLS,
  type ToolResult,
} from '@shared/mcp-server/dispatch';
import { createLogger } from '@shared/runtime/logger';

const log = createLogger('mcp-server');

export interface McpServerHandle {
  /** Stop the server and free the transport. Idempotent. */
  stop: () => Promise<void>;
}

export type ContextProvider = () => Promise<McpDispatchContext> | McpDispatchContext;

/**
 * Build a fresh Restura MCP server. `serveStdio` calls this factory once per
 * negotiated protocol transport, so modern and legacy clients never share
 * SDK session state.
 */
export function createResturaMcpServer(getContext: ContextProvider): McpServer {
  const server = new McpServer({
    name: 'restura',
    version: '0.1.0',
  });

  for (const tool of Object.values(TOOLS)) {
    // The SDK's registerTool has multiple overloads keyed on `inputSchema`'s
    // type: raw Zod shape vs. full schema vs. undefined. Iterating over a
    // heterogeneous TOOLS map produces a union of schema types that the
    // overload resolver can't narrow inside the loop body. We validate the
    // raw input ourselves in `dispatchTool` (each tool calls `parse()` first
    // thing), so the callback's argument typing isn't load-bearing — cast
    // through `unknown` to a permissive signature.
    const handler = (async (rawInput: unknown) => {
      const ctx = await getContext();
      const result = postProcessResult(dispatchTool(tool.name, rawInput, ctx));
      return toolResultToContent(result);
    }) as unknown as Parameters<typeof server.registerTool>[2];

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      handler
    );
  }

  return server;
}

/**
 * Start the v2 stdio server with the SDK's built-in legacy protocol support.
 */
export function startStdioMcpServer(getContext: ContextProvider): McpServerHandle {
  const handle = serveStdio(() => createResturaMcpServer(getContext), {
    legacy: 'serve',
    onerror: (error) => {
      log.error('stdio server error', { message: error.message });
    },
  });

  return {
    stop: () => handle.close(),
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
