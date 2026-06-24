import { z } from 'zod';
import {
  httpRequestSchema,
  grpcRequestSchema,
  sseRequestSchema,
  mcpRequestSchema,
  environmentSchema,
  collectionSchema,
} from './validations';
import type { Request, Environment, Collection } from '@/types';

/**
 * Schema for a single persisted console entry. Validated on rehydrate so a
 * single corrupt record (e.g. from a partial write or older app version)
 * doesn't poison the whole console.
 */
const ConsoleLogSchema = z.object({
  type: z.enum(['log', 'error', 'warn', 'info']),
  message: z.string(),
  timestamp: z.number(),
});

const ConsoleTestSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  error: z.string().optional(),
});

export const ConsoleFrameSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  // Keep in sync with FrameProtocol in useConsoleStore.ts.
  protocol: z.enum(['websocket', 'socketio', 'kafka', 'mqtt', 'sse']),
  direction: z.enum(['in', 'out', 'system']),
  connectionId: z.string().optional(),
  label: z.string().optional(),
  payload: z.string(),
  bytes: z.number().optional(),
});

export const ConsoleEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  protocol: z
    .enum(['http', 'grpc', 'graphql', 'mcp', 'sse', 'websocket', 'kafka', 'mqtt', 'socketio'])
    .optional(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.string().optional(),
  }),
  response: z.object({
    id: z.string(),
    requestId: z.string(),
    status: z.number(),
    statusText: z.string(),
    headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    body: z.string(),
    size: z.number(),
    time: z.number(),
    timestamp: z.number(),
  }),
  scriptLogs: z.array(ConsoleLogSchema).optional(),
  tests: z.array(ConsoleTestSchema).optional(),
  // Bytes sent on the wire (body + headers), when measurable.
  requestSize: z.number().optional(),
  // Pinned entries survive preserve-on-send clears and trimming.
  pinned: z.boolean().optional(),
  // Body exceeded the live capture cap and was cut at capture time.
  bodyTruncated: z.boolean().optional(),
  // Collection-run provenance (set when an entry comes from the runner).
  runId: z.string().optional(),
  runLabel: z.string().optional(),
  iteration: z.number().optional(),
});

/**
 * Validates a request object and returns validated data or throws
 */
export function validateRequest(request: unknown): Request {
  const httpResult = httpRequestSchema.safeParse(request);
  if (httpResult.success) {
    return httpResult.data as Request;
  }

  const grpcResult = grpcRequestSchema.safeParse(request);
  if (grpcResult.success) {
    return grpcResult.data as Request;
  }

  const sseResult = sseRequestSchema.safeParse(request);
  if (sseResult.success) {
    return sseResult.data as Request;
  }

  const mcpResult = mcpRequestSchema.safeParse(request);
  if (mcpResult.success) {
    return mcpResult.data as Request;
  }

  const errorDetails = {
    httpErrors: httpResult.error?.issues,
    grpcErrors: grpcResult.error?.issues,
    sseErrors: sseResult.error?.issues,
    mcpErrors: mcpResult.error?.issues,
  };

  console.error('Request validation failed:', errorDetails);

  throw new Error(
    `Request validation failed. No schema matched (http/grpc/sse/mcp). ` +
      `Errors: ${JSON.stringify(errorDetails)}`
  );
}

/**
 * Validates partial request updates
 */
export function validateRequestUpdate(current: Request, updates: Partial<Request>): Request {
  const merged = { ...current, ...updates };
  return validateRequest(merged);
}

/**
 * Validates an environment object
 */
export function validateEnvironment(env: unknown): Environment {
  const result = environmentSchema.safeParse(env);
  if (result.success) {
    // EOPT(maintainability): Zod's `.optional()` widens to `T | undefined`,
    // which the EOPT-strict Environment.variables[].description rejects.
    // Strip undefined-valued keys before returning.
    return {
      ...result.data,
      variables: result.data.variables.map((v) => {
        const { description, ...rest } = v;
        return description !== undefined ? { ...rest, description } : rest;
      }),
    };
  }

  console.error('Environment validation failed:', result.error?.issues);

  // Throw error to prevent invalid data from entering the store
  throw new Error(
    `Environment validation failed: ${result.error?.issues.map((e) => e.message).join(', ')}`
  );
}

/**
 * Validates a collection object
 */
export function validateCollection(collection: unknown): Collection {
  const result = collectionSchema.safeParse(collection);
  if (result.success) {
    return result.data;
  }

  console.error('Collection validation failed:', result.error?.issues);

  // Throw error to prevent invalid data from entering the store
  throw new Error(
    `Collection validation failed: ${result.error?.issues.map((e) => e.message).join(', ')}`
  );
}

/**
 * Safe JSON parse with validation
 */
export function safeParseJSON<T>(
  json: string,
  schema: z.ZodType<T>
): { success: true; data: T } | { success: false; error: string } {
  try {
    const parsed = JSON.parse(json);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: result.error.issues.map((e) => e.message).join(', '),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid JSON',
    };
  }
}

// ===========================
// AI Chat Store Schema
// ===========================

const SecretHandleRefSchema = z.object({
  kind: z.literal('handle'),
  id: z.uuid(),
  label: z.string().optional(),
});

// Chat allows the cloud set plus a local OpenAI-compatible provider (base-URL + no API key).
const ChatProviderEnumSchema = z.enum(['openai', 'anthropic', 'openrouter', 'openai-compatible']);

const ProviderConfigSchema = z.object({
  provider: ChatProviderEnumSchema,
  defaultModel: z.string().min(1),
  // Optional: local (openai-compatible) providers need no API key/handle.
  apiKeyRef: SecretHandleRefSchema.optional(),
  baseUrlOverride: z.url().optional(),
});

const ContextRefSchema = z.object({
  kind: z.enum(['request', 'response', 'history-entry', 'none']),
  tabId: z.string().optional(),
  historyId: z.string().optional(),
  capturedAt: z.number(),
});

const UsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  estimatedCostUSD: z.number(),
});

const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  text: z.string(),
  status: z.enum(['streaming', 'done', 'error']),
  errorMessage: z.string().optional(),
  usage: UsageSchema.optional(),
  contextRef: ContextRefSchema.optional(),
  rawMode: z.boolean().optional(),
  createdAt: z.number(),
});

const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(ChatMessageSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const AiChatStateSchema = z.object({
  conversations: z.record(z.string(), ConversationSchema),
  activeConversationId: z.string().nullable(),
  panelOpen: z.boolean(),
  panelWidth: z.number().min(280).max(800),
  providerConfigs: z.object({
    openai: ProviderConfigSchema.nullable(),
    anthropic: ProviderConfigSchema.nullable(),
    openrouter: ProviderConfigSchema.nullable(),
    'openai-compatible': ProviderConfigSchema.nullable(),
  }),
  activeProvider: ChatProviderEnumSchema,
  redactionMode: z.enum(['default', 'raw']),
  // When false, the chat does NOT advertise agent tools to the model, so it
  // won't propose actions. Optional + default so older persisted state upgrades
  // cleanly to the enabled-by-default behaviour.
  agentToolsEnabled: z.boolean().optional().default(true),
});

export type PersistedAiChatState = z.infer<typeof AiChatStateSchema>;

// ---------------------------------------------------------------------------
// AI Lab (Electron-only). Persisted in the aiLab / evalRuns Dexie tables.
// Provider enum is the wire superset (adds local runtimes).
// ---------------------------------------------------------------------------
const AiLabProviderEnumSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'ollama',
  'openai-compatible',
]);

const ModelRefSchema = z.object({
  providerConfigId: z.string(),
  model: z.string(),
});

const AiLabProviderConfigSchema = z.object({
  id: z.string(),
  provider: AiLabProviderEnumSchema,
  label: z.string(),
  baseUrl: z.string().optional(),
  apiKeyHandleId: z.string().optional(),
  pricingKnown: z.boolean(),
  isLocal: z.boolean(),
  models: z.array(z.string()),
  createdAt: z.number(),
});

const PromptTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  system: z.string(),
  user: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const DatasetCaseSchema = z.object({
  id: z.string(),
  vars: z.record(z.string(), z.string()),
  reference: z.string().optional(),
  expected: z.string().optional(),
  turns: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).optional(),
});

const DatasetSchema = z.object({
  id: z.string(),
  name: z.string(),
  cases: z.array(DatasetCaseSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// Scorers are a discriminated union; validate only id+kind here (the runner
// narrows on `kind`). z.object strips—not rejects—the per-kind fields, and the
// rehydrate path keeps the original state on success, so nothing is lost.
const ScorerConfigSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'exact-match',
    'contains',
    'regex',
    'json-valid',
    'json-schema',
    'latency',
    'cost',
    'script',
    'judge',
    'tool-call',
    'pairwise',
  ]),
});

const EvalConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  promptId: z.string(),
  datasetId: z.string(),
  models: z.array(ModelRefSchema),
  scorers: z.array(ScorerConfigSchema),
  concurrency: z.number().int().positive().max(32),
  // Validated loosely (kind only) — the runner narrows the rest. Keeps the
  // schema from rejecting future target kinds, matching the scorer approach.
  target: z.object({ kind: z.string() }).optional(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
      })
    )
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const AiLabStateSchema = z.object({
  providers: z.record(z.string(), AiLabProviderConfigSchema),
  prompts: z.record(z.string(), PromptTemplateSchema),
  datasets: z.record(z.string(), DatasetSchema),
  evalConfigs: z.record(z.string(), EvalConfigSchema),
});

export type PersistedAiLabState = z.infer<typeof AiLabStateSchema>;

const ScoreResultSchema = z.object({
  scorerId: z.string(),
  kind: z.string(),
  passed: z.boolean(),
  score: z.number().optional(),
  detail: z.string().optional(),
  perCriterion: z
    .array(
      z.object({
        name: z.string(),
        score: z.number(),
        pass: z.boolean(),
        reasoning: z.string(),
      })
    )
    .optional(),
  variance: z.number().optional(),
});

const EvalCellResultSchema = z.object({
  caseId: z.string(),
  modelRef: ModelRefSchema,
  output: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  latencyMs: z.number(),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).optional(),
  cost: z.number().nullable(),
  scores: z.array(ScoreResultSchema),
  passed: z.boolean(),
  notEvaluated: z.boolean().optional(),
  executed: z
    .object({
      status: z.number(),
      latencyMs: z.number(),
      bodyExcerpt: z.string(),
      ok: z.boolean(),
    })
    .optional(),
});

const EvalRunSchema = z.object({
  id: z.string(),
  evalConfigId: z.string(),
  configName: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  status: z.enum(['running', 'done', 'cancelled', 'error']),
  cells: z.array(EvalCellResultSchema),
  totalCells: z.number(),
});

export const EvalRunStateSchema = z.object({
  runs: z.record(z.string(), EvalRunSchema),
});

export type PersistedEvalRunState = z.infer<typeof EvalRunStateSchema>;

const ArenaMatchSchema = z.object({
  a: z.string(),
  b: z.string(),
  winner: z.enum(['a', 'b', 'tie']),
});

const ArenaRunSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  datasetName: z.string(),
  modelKeys: z.array(z.string()),
  modelLabels: z.record(z.string(), z.string()),
  matches: z.array(ArenaMatchSchema),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  status: z.enum(['running', 'done', 'cancelled', 'error']),
});

export const ArenaStateSchema = z.object({
  runs: z.record(z.string(), ArenaRunSchema),
});

export type PersistedArenaRunState = z.infer<typeof ArenaStateSchema>;

/**
 * Validates URL format
 */
export function isValidUrl(url: string): boolean {
  if (!url) return false;

  // Allow environment variable placeholders
  if (url.includes('{{') && url.includes('}}')) {
    // Basic check - has protocol-like start
    return /^(https?:\/\/|{{)/.test(url);
  }

  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
