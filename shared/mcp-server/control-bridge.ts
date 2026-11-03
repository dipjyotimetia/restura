/**
 * Wire contract between Electron main (which hosts the MCP transport) and the
 * renderer (which owns the data and runs every tool) — ADR 0041.
 *
 *   main  ── mcp-control:tool-call  (event)  ──► renderer
 *   main ◄── mcp-control:tool-result (invoke) ── renderer
 *
 * Main mints a `callId` per tool call, forwards it to the one renderer that
 * started the server, and parks the call until that renderer answers with the
 * same id, the call times out, or the server stops. Results are size-capped
 * and validated here before they go back to the agent.
 */

import { z } from 'zod';

/** Largest serialised tool result main accepts from the renderer. */
export const MAX_TOOL_RESULT_BYTES = 2_000_000;

/**
 * Upper bound on one tool call: covers a user reading an approval card and a
 * collection run. The renderer applies its own, shorter approval timeout.
 */
export const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;

/** How long an approval card waits for the user before the call is denied. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Concurrent in-flight tool calls main will park before refusing new ones. */
export const MAX_IN_FLIGHT_TOOL_CALLS = 16;

/** Self-reported MCP client identity — display only, never trusted. */
export interface ToolCallClient {
  name: string;
  version?: string;
}

/** Payload of the main → renderer `mcp-control:tool-call` event. */
export interface ToolCallEvent {
  callId: string;
  tool: string;
  input: unknown;
  /** Self-reported by the MCP client at initialize — display only, never trusted. */
  client?: ToolCallClient;
}

/** Largest error message carried back from the renderer. */
export const MAX_TOOL_ERROR_CHARS = 10_000;

export type ControlToolResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Payload of the renderer → main `mcp-control:tool-result` invoke. Validated
 * in main by `ToolCallResultPayloadSchema` (electron/main/ipc/validators/mcp-control.ts).
 */
export interface ToolCallResultPayload {
  callId: string;
  result: ControlToolResult;
}

/**
 * Payload of `mcp-control:start` (validated by `ControlServerStartSchema`).
 * Every start mints a fresh bearer token, so starting again also rotates it.
 */
export interface ControlServerStartOptions {
  preferredPort?: number;
}

/** How an agent launches the `--mcp-server` relay for *this* install. */
export interface AgentLaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Shown next to the configs when the command will not survive a restart. */
  warning?: string;
}

/** Printable ASCII, trimmed, bounded — for client labels shown in the UI. */
export function sanitizeLabel(value: string, max = 120): string {
  return value
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, max);
}

export interface ControlServerStatus {
  running: boolean;
  port?: number;
  /** `http://127.0.0.1:<port>/mcp` while running. */
  url?: string;
  /** Last tool call main served, ms since epoch. */
  lastCallAt?: number;
  /** Tool calls currently parked waiting on the renderer. */
  inFlight: number;
}

/**
 * Handshake file written (mode 0600) under userData while the server runs, so
 * the stdio shim can find the running app without a token in any agent config.
 */
export const HandshakeFileSchema = z.object({
  version: z.literal(1),
  running: z.boolean(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(32).max(256),
  pid: z.number().int().positive(),
  updatedAt: z.number(),
});
export type HandshakeFile = z.infer<typeof HandshakeFileSchema>;

export const HANDSHAKE_FILE_NAME = 'mcp-control.json';
export const CONTROL_SERVER_PATH = '/mcp';
