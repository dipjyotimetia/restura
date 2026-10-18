import { z } from 'zod';
import { McpConnectSchema } from './core';

/**
 * `mcp:conformance` (#911): one self-contained run (connects per era, runs the
 * scripted sequence, tears down). No connection id: nothing outlives the call.
 */
export const McpConformanceSchema = McpConnectSchema.omit({ connectionId: true }).extend({
  sampleCalls: z.enum(['off', 'read-only', 'selected']).default('off'),
  /** Non-read-only tools the user explicitly approved (never overrides destructive). */
  approvedTools: z.array(z.string().min(1).max(256)).max(200).default([]),
  eras: z
    .array(z.enum(['legacy', 'modern']))
    .min(1)
    .max(2)
    .default(['legacy', 'modern']),
});

export type McpConformanceConfig = z.infer<typeof McpConformanceSchema>;
