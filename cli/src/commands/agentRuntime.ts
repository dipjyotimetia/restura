import { z } from 'zod';

const SourceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

const EnvironmentHeaderSchema = z
  .object({
    name: z.string().min(1).max(200),
    env: z.string().min(1).max(200),
  })
  .strict();

const CollectionSourceSchema = z
  .object({
    id: SourceIdSchema,
    kind: z.literal('collection'),
    path: z.string().min(1),
    requestIds: z.array(SourceIdSchema).min(1).max(500),
  })
  .strict();

const McpSourceSchema = z
  .object({
    id: SourceIdSchema,
    kind: z.literal('mcp'),
    url: z.url(),
    transport: z.enum(['streamable-http', 'http-sse']),
    headers: z.array(EnvironmentHeaderSchema).max(100).default([]),
    /** A human-controlled CI assertion; non-read-only MCP tools are never exposed. */
    readOnly: z.literal(true),
    allowedTools: z.array(z.string().min(1).max(200)).min(1).max(500),
  })
  .strict();

const A2aSourceSchema = z
  .object({
    id: SourceIdSchema,
    kind: z.literal('a2a'),
    /** Must equal the suite's `a2a` tool source endpoint exactly. */
    endpoint: z.url(),
    headers: z.array(EnvironmentHeaderSchema).max(100).default([]),
    /**
     * A human-controlled CI assertion that calling this agent is safe
     * unattended. Without it A2A calls are approval-required, which CI cannot give.
     */
    readOnly: z.literal(true),
  })
  .strict();

const PriceSchema = z.number().finite().min(0);

/** USD per million tokens; cache rates are optional and only needed when the provider reports cached tokens. */
const ModelPriceSchema = z
  .object({
    inputUSDPerMTok: PriceSchema,
    outputUSDPerMTok: PriceSchema,
    cacheReadUSDPerMTok: PriceSchema.optional(),
    cacheWriteUSDPerMTok: PriceSchema.optional(),
  })
  .strict();

const HttpsUrlSchema = z.url().refine((value) => value.startsWith('https://'), {
  message: 'provider endpoints must use https',
});

/** Operator-owned endpoints for providers whose host is per customer or region. */
const ProviderEndpointsSchema = z
  .object({
    /** Azure OpenAI resource, e.g. https://acme.openai.azure.com (required for azure.openai). */
    'azure.openai': HttpsUrlSchema.optional(),
    /** Bedrock runtime for a region; defaults to us-east-1. */
    'aws.bedrock.converse': HttpsUrlSchema.optional(),
    /** Gemini API; defaults to https://generativelanguage.googleapis.com. */
    'google.generateContent': HttpsUrlSchema.optional(),
  })
  .strict();

/**
 * Non-portable runtime bindings for a portable agent suite. Values that can
 * carry credentials are environment variable names, never inline secrets.
 */
export const AgentRuntimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z
      .array(
        z.discriminatedUnion('kind', [CollectionSourceSchema, McpSourceSchema, A2aSourceSchema])
      )
      .max(100),
    /** Per-model price overrides (keyed by model id) for cost budgets and cost graders. */
    modelPrices: z.record(z.string().min(1).max(200), ModelPriceSchema).optional(),
    providerEndpoints: ProviderEndpointsSchema.optional(),
  })
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    const requestSourceIds = new Map<string, string>();
    for (const [index, source] of manifest.sources.entries()) {
      if (seen.has(source.id)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate runtime source id: ${source.id}`,
          path: ['sources', index, 'id'],
        });
      }
      seen.add(source.id);
      if (source.kind === 'collection') {
        for (const requestId of source.requestIds) {
          const firstSourceId = requestSourceIds.get(requestId);
          if (firstSourceId) {
            context.addIssue({
              code: 'custom',
              message: `request id ${requestId} is listed by both ${firstSourceId} and ${source.id}`,
              path: ['sources', index, 'requestIds'],
            });
          } else {
            requestSourceIds.set(requestId, source.id);
          }
        }
      }
    }
  });

export type AgentRuntimeManifest = z.infer<typeof AgentRuntimeManifestSchema>;
export type AgentRuntimeSource = AgentRuntimeManifest['sources'][number];
