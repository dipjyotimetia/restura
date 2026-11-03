import {
  type ControlServerStartOptions,
  type ControlToolResult,
  MAX_TOOL_ERROR_CHARS,
  type ToolCallResultPayload,
} from '@shared/mcp-server/control-bridge';
import { z } from 'zod';

// ===========================
// MCP control server (ADR 0041)
// ===========================

export const ToolResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(MAX_TOOL_ERROR_CHARS) }),
]) satisfies z.ZodType<ControlToolResult>;

/** `mcp-control:tool-result` — the renderer's answer to one forwarded call. */
export const ToolCallResultPayloadSchema = z.object({
  callId: z.string().uuid(),
  result: ToolResultSchema,
}) satisfies z.ZodType<ToolCallResultPayload>;

/** `mcp-control:start`. */
export const ControlServerStartSchema = z.object({
  preferredPort: z.number().int().min(1024).max(65535).optional(),
}) satisfies z.ZodType<ControlServerStartOptions>;
