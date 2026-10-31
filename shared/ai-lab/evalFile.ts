// Portable dataset-eval file (`restura.eval` v1): what the desktop exports and
// `restura eval run` executes. It carries the prompt, dataset, scorers and the
// models by endpoint, never a credential: each endpoint names the environment
// variable the CLI reads its key from (ADR 0038).
import { z } from 'zod';
import type { Provider } from '../protocol/ai/types';
import type { Dataset, EvalTarget, ModelRef, PromptTemplate, ScorerConfig } from './types';

export const EVAL_FILE_KIND = 'restura.eval' as const;
export const EVAL_FILE_SCHEMA_VERSION = 1 as const;

const IdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

const ModelRefSchema = z.object({ providerConfigId: IdSchema, model: z.string().min(1).max(500) });

const CriterionSchema = z.object({
  name: z.string().min(1).max(200),
  rubric: z.string().max(10_000),
  weight: z.number().positive().optional(),
  gate: z.boolean().optional(),
});
const AnchorSchema = z.object({
  output: z.string().max(100_000),
  score: z.number().min(0).max(1),
  note: z.string().max(2_000).optional(),
});

const ScorerBase = { id: z.string().min(1).max(200), label: z.string().max(200).optional() };

export const EvalScorerSchema = z.discriminatedUnion('kind', [
  z.object({
    ...ScorerBase,
    kind: z.literal('exact-match'),
    expectedFrom: z.enum(['expected', 'reference']),
    caseInsensitive: z.boolean().optional(),
  }),
  z.object({
    ...ScorerBase,
    kind: z.literal('contains'),
    needle: z.string(),
    caseInsensitive: z.boolean().optional(),
  }),
  z.object({
    ...ScorerBase,
    kind: z.literal('regex'),
    pattern: z.string().max(10_000),
    flags: z.string().max(10).optional(),
  }),
  z.object({ ...ScorerBase, kind: z.literal('json-valid') }),
  z.object({ ...ScorerBase, kind: z.literal('json-schema'), schema: z.string().max(200_000) }),
  z.object({ ...ScorerBase, kind: z.literal('latency'), maxMs: z.number().positive() }),
  z.object({ ...ScorerBase, kind: z.literal('cost'), maxUSD: z.number().min(0) }),
  z.object({ ...ScorerBase, kind: z.literal('script'), code: z.string().max(200_000) }),
  z.object({
    ...ScorerBase,
    kind: z.literal('judge'),
    judgeModel: ModelRefSchema,
    passThreshold: z.number().min(0).max(1),
    rubric: z.string().max(20_000).optional(),
    criteria: z.array(CriterionSchema).max(50).optional(),
    samples: z.number().int().min(1).max(5).optional(),
    anchors: z.array(AnchorSchema).max(20).optional(),
  }),
  z.object({
    ...ScorerBase,
    kind: z.literal('tool-call'),
    expectedTool: z.string().max(200).optional(),
    argsSchema: z.string().max(200_000).optional(),
    expectedArgsFrom: z.enum(['expected', 'reference']).optional(),
  }),
  z.object({
    ...ScorerBase,
    kind: z.literal('pairwise'),
    judgeModel: ModelRefSchema,
    baseline: z.literal('reference'),
    passThreshold: z.number().min(0).max(1),
    criteria: z.array(CriterionSchema).max(50).optional(),
    swapPositions: z.boolean().optional(),
  }),
]);

/** Wire providers an eval file may name. */
export const EvalEndpointProviderSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'huggingface',
  'azure-openai',
  'gemini',
  'bedrock',
  'ollama',
  'openai-compatible',
]);

const EnvNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const EvalEndpointSchema = z.object({
  provider: EvalEndpointProviderSchema,
  /** Label shown in reports (the desktop provider name). */
  label: z.string().max(200).optional(),
  /** Environment variable holding the API key. Omit only for keyless local runtimes. */
  credentialEnv: EnvNameSchema.optional(),
  baseUrl: z.url().optional(),
});

const PriceSchema = z.number().finite().min(0);
const ModelPriceSchema = z
  .object({
    inputUSDPerMTok: PriceSchema,
    outputUSDPerMTok: PriceSchema,
    cacheReadUSDPerMTok: PriceSchema.optional(),
    cacheWriteUSDPerMTok: PriceSchema.optional(),
  })
  .strict();

export const EvalFileSchema = z
  .object({
    kind: z.literal(EVAL_FILE_KIND),
    schemaVersion: z.literal(EVAL_FILE_SCHEMA_VERSION),
    name: z.string().min(1).max(500),
    prompt: z.object({ system: z.string().max(200_000), user: z.string().max(200_000) }),
    dataset: z.object({
      name: z.string().max(500),
      cases: z
        .array(
          z.object({
            id: z.string().min(1).max(200),
            vars: z.record(z.string(), z.string()),
            reference: z.string().optional(),
            expected: z.string().optional(),
            turns: z
              .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
              .max(200)
              .optional(),
            split: z.enum(['train', 'test']).optional(),
          })
        )
        .min(1)
        .max(10_000),
    }),
    /** Keyed by the id ModelRefs use as `providerConfigId`. */
    endpoints: z.record(IdSchema, EvalEndpointSchema),
    models: z.array(ModelRefSchema).min(1).max(50),
    scorers: z.array(EvalScorerSchema).max(50),
    concurrency: z.number().int().min(1).max(32),
    passThreshold: z.number().min(0).max(1).default(1),
    tools: z
      .array(
        z.object({
          name: z.string().min(1).max(64),
          description: z.string().max(4_000),
          inputSchema: z.record(z.string(), z.unknown()),
        })
      )
      .max(32)
      .optional(),
    target: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('text') }),
        z.object({
          kind: z.literal('http-exec'),
          parseFrom: z.enum(['json', 'fenced']),
          protocol: z.enum(['http', 'graphql']),
        }),
      ])
      .optional(),
    /** USD per million tokens by model id, for providers without a static price table. */
    modelPrices: z.record(z.string().min(1).max(500), ModelPriceSchema).optional(),
  })
  .superRefine((file, context) => {
    const refs = [
      ...file.models.map((model, index) => ({ model, path: ['models', index] })),
      ...file.scorers.flatMap((scorer, index) =>
        scorer.kind === 'judge' || scorer.kind === 'pairwise'
          ? [{ model: scorer.judgeModel, path: ['scorers', index, 'judgeModel'] }]
          : []
      ),
    ];
    for (const { model, path } of refs) {
      if (!Object.hasOwn(file.endpoints, model.providerConfigId)) {
        context.addIssue({
          code: 'custom',
          message: `unknown endpoint: ${model.providerConfigId}`,
          path,
        });
      }
    }
  });

export type EvalFile = z.infer<typeof EvalFileSchema>;
export type EvalEndpoint = z.infer<typeof EvalEndpointSchema>;

/** Conventional environment variable per provider (`AWS_BEARER_TOKEN_BEDROCK` is AWS's own name). */
export const DEFAULT_CREDENTIAL_ENV: Partial<Record<Provider, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface: 'HF_TOKEN',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  bedrock: 'AWS_BEARER_TOKEN_BEDROCK',
};

export interface EvalFileSource {
  name: string;
  prompt: Pick<PromptTemplate, 'system' | 'user'>;
  dataset: Pick<Dataset, 'name' | 'cases'>;
  models: ModelRef[];
  scorers: ScorerConfig[];
  concurrency: number;
  passThreshold?: number;
  tools?: EvalFile['tools'];
  target?: EvalTarget;
  /** Provider configs keyed by id; only the ones the eval references are exported. */
  providers: Record<string, { provider: Provider; label?: string; baseUrl?: string }>;
}

/** Build the portable file from desktop state. Credentials become env-variable names. */
export function buildEvalFile(source: EvalFileSource): EvalFile {
  const used = new Set<string>(source.models.map((model) => model.providerConfigId));
  for (const scorer of source.scorers) {
    if (scorer.kind === 'judge' || scorer.kind === 'pairwise') {
      used.add(scorer.judgeModel.providerConfigId);
    }
  }
  const endpoints: EvalFile['endpoints'] = {};
  for (const id of used) {
    const config = source.providers[id];
    if (!config) throw new Error(`provider ${id} is not configured`);
    const credentialEnv = DEFAULT_CREDENTIAL_ENV[config.provider];
    endpoints[id] = {
      provider: config.provider,
      ...(config.label ? { label: config.label } : {}),
      ...(credentialEnv ? { credentialEnv } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };
  }
  return EvalFileSchema.parse({
    kind: EVAL_FILE_KIND,
    schemaVersion: EVAL_FILE_SCHEMA_VERSION,
    name: source.name,
    prompt: { system: source.prompt.system, user: source.prompt.user },
    dataset: { name: source.dataset.name, cases: source.dataset.cases },
    endpoints,
    models: source.models,
    scorers: source.scorers,
    concurrency: source.concurrency,
    passThreshold: source.passThreshold ?? 1,
    ...(source.tools ? { tools: source.tools } : {}),
    ...(source.target ? { target: source.target } : {}),
  });
}
