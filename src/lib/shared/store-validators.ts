import { AgentSuiteSchema } from '@shared/agent-lab';
import { z } from 'zod';
import { AiLabReportEnvelopeSchema } from '@/features/ai-lab/run-engine/reportEnvelope';
import type { Collection, Environment, Request, SpatialAccent } from '@/types';
import { SPATIAL_ACCENT_PRESETS } from '@/types';
import {
  collectionSchema,
  environmentSchema,
  grpcRequestSchema,
  httpRequestSchema,
  mcpRequestSchema,
  minTlsVersionSchema,
  proxyTypeSchema,
  sseRequestSchema,
} from './validations';

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
  protocol: z.enum(['websocket', 'socketio', 'kafka', 'mqtt', 'sse', 'grpc']),
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
  // Request URL with `{{variables}}` substituted — see ConsoleEntry.resolvedUrl.
  resolvedUrl: z.string().optional(),
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
  'huggingface',
  'openai-compatible',
]);

const ModelRefSchema = z.object({
  providerConfigId: z.string(),
  model: z.string(),
});

const ModelCapabilitiesShapeSchema = z.object({
  inputModalities: z
    .array(z.enum(['text', 'image', 'audio', 'document']))
    .min(1)
    .max(4),
  outputModalities: z
    .array(z.enum(['text', 'image', 'audio', 'document']))
    .min(1)
    .max(4),
  structuredOutput: z.boolean(),
  toolCalling: z.boolean(),
  parallelToolCalls: z.boolean(),
  reasoning: z.boolean(),
  continuation: z.boolean(),
  serverTools: z.array(z.string().trim().min(1).max(64)).max(32),
  maxContextTokens: z.number().int().positive().max(100_000_000).optional(),
  maxOutputTokens: z.number().int().positive().max(100_000_000).optional(),
});

function requireCapabilityInvariants(
  capabilities: {
    toolCalling?: boolean | undefined;
    parallelToolCalls?: boolean | undefined;
    serverTools?: string[] | undefined;
  },
  context: z.RefinementCtx
) {
  if (capabilities.parallelToolCalls && !capabilities.toolCalling) {
    context.addIssue({ code: 'custom', message: 'parallel tool calls require tool calling' });
  }
  if (capabilities.serverTools?.length && !capabilities.toolCalling) {
    context.addIssue({ code: 'custom', message: 'server tools require tool calling' });
  }
  if (
    capabilities.serverTools &&
    new Set(capabilities.serverTools).size !== capabilities.serverTools.length
  ) {
    context.addIssue({ code: 'custom', message: 'server tools must be unique' });
  }
}

const ModelCapabilitiesSchema = ModelCapabilitiesShapeSchema.superRefine(
  requireCapabilityInvariants
);
const PartialModelCapabilitiesSchema = ModelCapabilitiesShapeSchema.partial().superRefine(
  requireCapabilityInvariants
);
const AgentCapabilityProvenanceSchema = z.object({
  source: z.literal('discovered'),
  adapterId: z.literal('openrouter.models'),
  adapterVersion: z.literal(1),
});

const AiLabModelDetailSchema = z
  .object({
    label: z.string().optional(),
    contextLength: z.number().optional(),
    modality: z.string().optional(),
    pricing: z
      .object({
        promptPerMTokUSD: z.number().optional(),
        completionPerMTokUSD: z.number().optional(),
      })
      .optional(),
    agentCapabilities: PartialModelCapabilitiesSchema.optional(),
    agentCapabilityProvenance: AgentCapabilityProvenanceSchema.optional(),
    createdAt: z.string().optional(),
    vendor: z.string().optional(),
    family: z.string().optional(),
    parameterSize: z.string().optional(),
    quantizationLevel: z.string().optional(),
    sizeBytes: z.number().optional(),
    modifiedAt: z.string().optional(),
  })
  // Forward-compatible: ignore unknown fields the renderer may add later.
  // Zod v4 deprecated `.passthrough()` in favor of `.loose()` (same semantics,
  // new method name) — the type signature is identical (ZodObject<Shape, $loose>).
  .loose()
  .superRefine((detail, context) => {
    if (Boolean(detail.agentCapabilities) !== Boolean(detail.agentCapabilityProvenance)) {
      context.addIssue({
        code: 'custom',
        message: 'discovered capabilities require tested adapter provenance',
      });
    }
  });

const AiLabProviderConfigSchema = z
  .object({
    id: z.string(),
    provider: AiLabProviderEnumSchema,
    label: z.string(),
    baseUrl: z.string().optional(),
    apiKeyHandleId: z.string().optional(),
    pricingKnown: z.boolean(),
    costPolicy: z.enum(['unknown', 'local-zero']).default('unknown'),
    isLocal: z.boolean(),
    models: z.array(z.string()),
    // Per-model metadata captured at the most recent discovery (OpenRouter).
    // Optional so existing persisted state validates without a migration.
    modelDetails: z.record(z.string(), AiLabModelDetailSchema).optional(),
    // Explicit, full per-model user assertions. Optional for additive migration.
    capabilityOverrides: z.record(z.string(), ModelCapabilitiesSchema).optional(),
    // Most recent connection-test outcome (optional; no migration needed).
    lastTest: z
      .object({
        ok: z.boolean(),
        at: z.number(),
        modelCount: z.number().optional(),
        error: z.string().optional(),
      })
      .optional(),
    lastDiscoveredAt: z.number().optional(),
    createdAt: z.number(),
  })
  .superRefine((config, context) => {
    if (
      config.provider !== 'openrouter' &&
      Object.values(config.modelDetails ?? {}).some(
        (detail) => detail.agentCapabilityProvenance?.adapterId === 'openrouter.models'
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'OpenRouter capability provenance requires an OpenRouter provider',
      });
    }
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
  favoriteModelKeys: z.array(z.string()).default([]),
  recentModelKeys: z.array(z.string()).max(20).default([]),
  agentSuites: z.record(z.string(), AgentSuiteSchema).default({}),
  runReports: z.record(z.string(), AiLabReportEnvelopeSchema).default({}),
  reportQuarantineCount: z.number().int().nonnegative().default(0),
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
  // Run metadata for reports (optional; absent on runs recorded before it).
  datasetId: z.string().optional(),
  datasetName: z.string().optional(),
  modelLabels: z.record(z.string(), z.string()).optional(),
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

// ---------------------------------------------------------------------------
// App settings (useSettingsStore) — validated on rehydrate so a corrupt or
// partial persisted blob can't crash the app or feed invalid scalars (theme,
// accent, numeric ranges, judge config) into the UI. Every field `.catch`es a
// sane fallback so parsing never throws; unknown/future keys pass through and
// the store merges the result over its runtime defaults.
// ---------------------------------------------------------------------------

const SettingsProxySchema = z
  .object({
    enabled: z.boolean().catch(false),
    type: proxyTypeSchema.catch('http'),
    host: z.string().catch(''),
    port: z.number().int().min(1).max(65535).catch(8080),
    // SecretValue (inline string or SecretRef handle); shape is enforced where
    // it's resolved, so keep it loose here.
    auth: z.object({ username: z.string(), password: z.unknown() }).optional().catch(undefined),
    bypassList: z.array(z.string()).optional().catch(undefined),
  })
  .catch({ enabled: false, type: 'http', host: '', port: 8080 });

const ClientCertCatchSchema = z.object({ format: z.enum(['pfx', 'pem']) }).passthrough();
const CaCertCatchSchema = z.object({ pem: z.string() }).passthrough();

export const appSettingsSchema = z
  .object({
    // Required fields use `.optional().catch(undefined)` too: an invalid or
    // absent value is stripped and backfilled from the caller's `defaults`, so
    // `defaultSettings` stays the single source of truth for defaults (the
    // schema doesn't carry a second, hard-coded copy that could drift).
    proxy: SettingsProxySchema.optional().catch(undefined),
    defaultTimeout: z.number().int().min(1).max(600_000).optional().catch(undefined),
    followRedirects: z.boolean().optional().catch(undefined),
    maxRedirects: z.number().int().min(0).max(50).optional().catch(undefined),
    verifySsl: z.boolean().optional().catch(undefined),
    autoSaveHistory: z.boolean().optional().catch(undefined),
    maxHistoryItems: z.number().int().min(1).max(100_000).optional().catch(undefined),
    theme: z.enum(['light', 'dark', 'system']).optional().catch(undefined),
    layoutOrientation: z.enum(['vertical', 'horizontal']).optional().catch(undefined),
    requestResponseSplit: z.number().min(0).max(100).optional().catch(undefined),
    allowLocalhost: z.boolean().optional().catch(undefined),
    allowPrivateIPs: z.boolean().optional().catch(undefined),
    clientCert: ClientCertCatchSchema.optional().catch(undefined),
    caCert: CaCertCatchSchema.optional().catch(undefined),
    clientCertificates: z
      .array(
        z
          .object({
            id: z.string(),
            host: z.string(),
            port: z.number().optional(),
            cert: ClientCertCatchSchema,
          })
          .passthrough()
      )
      .optional()
      .catch(undefined),
    caCertificates: z
      .array(
        z
          .object({
            id: z.string(),
            host: z.string(),
            port: z.number().optional(),
            pem: z.string(),
          })
          .passthrough()
      )
      .optional()
      .catch(undefined),
    followOriginalMethod: z.boolean().optional().catch(undefined),
    followAuthHeader: z.boolean().optional().catch(undefined),
    stripReferer: z.boolean().optional().catch(undefined),
    encodeUrlAutomatically: z.boolean().optional().catch(undefined),
    disableCookieJar: z.boolean().optional().catch(undefined),
    serverCipherOrder: z.boolean().optional().catch(undefined),
    minTlsVersion: minTlsVersionSchema.optional().catch(undefined),
    cipherSuites: z.string().optional().catch(undefined),
    telemetry: z
      .object({ errorsEnabled: z.boolean().catch(true) })
      .optional()
      .catch(undefined),
    accent: z
      .enum(SPATIAL_ACCENT_PRESETS as unknown as [SpatialAccent, ...SpatialAccent[]])
      .optional()
      .catch(undefined),
    autoUpdate: z
      .object({
        autoDownload: z.boolean().catch(true),
        channel: z.enum(['stable', 'beta']).catch('stable'),
      })
      .optional()
      .catch(undefined),
    judge: z
      .object({
        enabled: z.boolean().catch(false),
        provider: z
          .enum(['openai', 'anthropic', 'openrouter', 'ollama', 'openai-compatible'])
          .catch('openai'),
        model: z.string().catch(''),
        apiKeyHandleId: z.string().optional().catch(undefined),
        baseUrl: z.string().optional().catch(undefined),
        redactBeforeJudge: z.boolean().catch(true),
      })
      .optional()
      .catch(undefined),
  })
  .passthrough();

/**
 * Validate a persisted `AppSettings` blob on rehydrate, merging the cleaned
 * result over the supplied runtime defaults. A field that fails validation
 * falls back individually (via `.catch`); a wholesale failure (non-object)
 * returns the defaults untouched. Never throws.
 */
export function validatePersistedSettings<T extends object>(raw: unknown, defaults: T): T {
  const result = appSettingsSchema.safeParse(raw);
  if (!result.success) return defaults;
  // Strip `undefined` values (a dropped/invalid optional field `.catch`es to
  // undefined) so the spread can't blow away a default with an explicit
  // undefined — the default must win for those keys. `corsProxy` was a
  // persisted preference before web requests became unconditionally
  // Worker-proxied; drop it explicitly while preserving other future keys.
  const cleaned = Object.fromEntries(
    Object.entries(result.data).filter(([key, value]) => key !== 'corsProxy' && value !== undefined)
  );
  return { ...defaults, ...(cleaned as Partial<T>) };
}

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
