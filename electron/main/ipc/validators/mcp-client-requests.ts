import { isLocalFileRootUri } from '@shared/protocol/mcp-roots';
import { z } from 'zod';
import { McpConnectionIdSchema } from './core';

// ===========================
// MCP server→client requests (#860): elicitation, sampling, roots
// ===========================

/** Main-generated id that routes one pending server→client request. */
const McpClientRequestIdSchema = z.uuid();

const MAX_SAMPLING_TEXT_LENGTH = 1_000_000;
const MAX_ELICITATION_CONTENT_KEYS = 100;

/**
 * Elicitation answer. `content` is only shape-checked here; main validates it
 * against the pending request's `requestedSchema` before answering the server.
 */
const ElicitationResponseSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('accept'),
    content: z
      .record(
        z.string().max(256),
        z.union([
          z.string().max(100_000),
          z.number(),
          z.boolean(),
          z.array(z.string().max(10_000)).max(1_000),
        ])
      )
      .refine((content) => Object.keys(content).length <= MAX_ELICITATION_CONTENT_KEYS, {
        message: `Elicitation content may have at most ${MAX_ELICITATION_CONTENT_KEYS} fields`,
      }),
  }),
  z.object({ action: z.literal('decline') }),
  z.object({ action: z.literal('cancel') }),
]);

/** Sampling answer: explicit human approval with the reviewed text, or rejection. */
const SamplingResponseSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    text: z.string().max(MAX_SAMPLING_TEXT_LENGTH),
    model: z.string().min(1).max(256),
  }),
  z.object({ action: z.literal('reject') }),
]);

export const McpClientResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('elicitation'),
    connectionId: McpConnectionIdSchema,
    requestId: McpClientRequestIdSchema,
    response: ElicitationResponseSchema,
  }),
  z.object({
    kind: z.literal('sampling'),
    connectionId: McpConnectionIdSchema,
    requestId: McpClientRequestIdSchema,
    response: SamplingResponseSchema,
  }),
]);

/** Roots must be local `file://` URIs (see `isLocalFileRootUri`). */
export const McpRootSchema = z.object({
  uri: z.string().max(4096).refine(isLocalFileRootUri, {
    message: 'Root URI must be a local file:// URI (no host other than localhost, no credentials)',
  }),
  name: z.string().max(256).optional(),
});

export const MAX_MCP_ROOTS = 100;

export const McpSetRootsSchema = z.object({
  connectionId: McpConnectionIdSchema,
  roots: z.array(McpRootSchema).max(MAX_MCP_ROOTS),
});

export type McpClientResponse = z.infer<typeof McpClientResponseSchema>;
export type McpRoot = z.infer<typeof McpRootSchema>;
export type McpSetRootsConfig = z.infer<typeof McpSetRootsSchema>;
