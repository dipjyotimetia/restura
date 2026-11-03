// IPC channels: Local mock server, browser-capture bridge and the MCP control
// server (Restura-as-an-MCP-server, ADR 0041).
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const LOCAL_SERVICES_IPC = {
  mock: {
    start: 'mock:start',
    stop: 'mock:stop',
    status: 'mock:status',
  },
  captureBridge: {
    start: 'capture-bridge:start',
    stop: 'capture-bridge:stop',
    status: 'capture-bridge:status',
  },
  mcpControl: {
    start: 'mcp-control:start',
    stop: 'mcp-control:stop',
    status: 'mcp-control:status',
    // Renderer → main: the answer to one forwarded tool call.
    toolResult: 'mcp-control:tool-result',
  },
} as const;

export const LOCAL_SERVICES_EVENT = {
  // A captured browser session arrived over the loopback bridge and was
  // converted to an OpenCollection document for the renderer to import.
  captureReceived: 'capture-bridge:received',
  // Main → renderer: an agent called a tool; the renderer runs it (consent,
  // approval, stores) and answers on IPC.mcpControl.toolResult.
  mcpControlToolCall: 'mcp-control:tool-call',
  // Main → renderer: a forwarded call ended without an answer (agent
  // cancelled, timed out, server stopped) — drop its approval card.
  mcpControlToolCancelled: 'mcp-control:tool-cancelled',
} as const;
