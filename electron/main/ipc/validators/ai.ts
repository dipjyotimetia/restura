import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { AgentTelemetryConfigSchema } from '@shared/agent-lab/telemetry-config';
import { z } from 'zod';

// ===========================
// AI Chat Schemas
// ===========================

const AiChatToolCallSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  input: z.string().max(200_000),
});

export const AiChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(200_000), // ~50k tokens; over this is almost certainly a bug
  toolCallId: z.string().min(1).max(200).optional(),
  toolCalls: z.array(AiChatToolCallSchema).max(64).optional(),
});

export const AiChatToolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(4000),
  inputSchema: z.record(z.string(), z.unknown()),
});

/**
 * Inference (complete/stream): cloud providers require an API key handle.
 * Local runtimes (ollama, openai-compatible) may legitimately run keyless. The
 * provider enum values are all valid `Provider` union members, so the cast is
 * safe. Without this guard a keyless cloud call would send an empty `Bearer`
 * header and 401 at the provider wire — a confusing error vs. a clear
 * validation message. Defense-in-depth alongside the SSRF/host checks.
 */
const requireInferenceKey = (v: { provider: string; apiKeyHandleId?: string }) =>
  isLocalProvider(v.provider as Provider) || !!v.apiKeyHandleId;

export const AiChatRequestSchema = z
  .object({
    streamId: z.uuid(),
    // Chat allows the cloud set plus a local openai-compatible endpoint.
    provider: z.enum(['openai', 'anthropic', 'openrouter', 'openai-compatible']),
    model: z.string().min(1).max(120),
    messages: z.array(AiChatMessageSchema).min(1).max(200),
    // Optional: a local openai-compatible provider needs no API key handle.
    apiKeyHandleId: z.uuid().optional(),
    baseUrlOverride: z.url().optional(),
    rawMode: z.boolean(),
    maxOutputTokens: z.number().int().positive().max(8192).optional(),
    tools: z.array(AiChatToolSchema).max(32).optional(),
  })
  // openai-compatible has no default endpoint — it must carry a base URL.
  .refine((v) => v.provider !== 'openai-compatible' || !!v.baseUrlOverride, {
    message: 'openai-compatible provider requires a base URL.',
    path: ['baseUrlOverride'],
  })
  // Cloud providers (openai / anthropic / openrouter) REQUIRE an API key handle —
  // without it the call would send an empty `Bearer` header and 401 at the wire.
  // Local runtimes (openai-compatible) may legitimately run keyless.
  .refine(requireInferenceKey, {
    message: 'This provider requires an API key. Add one in AI settings first.',
    path: ['apiKeyHandleId'],
  });

export const AiChatCancelSchema = z.object({
  streamId: z.uuid(),
});

// ---------------------------------------------------------------------------
// AI Lab (Electron-only). Superset of the chat providers — adds local runtimes
// (Ollama, generic OpenAI-compatible). The API-key handle is OPTIONAL because a
// bare local Ollama needs no key. `openai-compatible` always needs a base URL
// (it has no sensible default); the handler/refine enforces that.
// ---------------------------------------------------------------------------
const AiLabProviderSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'ollama',
  'huggingface',
  'openai-compatible',
]);

const AiLabCompleteBase = z.object({
  provider: AiLabProviderSchema,
  model: z.string().min(1).max(200),
  messages: z.array(AiChatMessageSchema).min(1).max(200),
  apiKeyHandleId: z.uuid().optional(),
  baseUrlOverride: z.url().optional(),
  rawMode: z.boolean(),
  maxOutputTokens: z.number().int().positive().max(32_768).optional(),
  tools: z.array(AiChatToolSchema).max(32).optional(),
});

const requireBaseForCompat = (v: { provider: string; baseUrlOverride?: string }) =>
  v.provider !== 'openai-compatible' || !!v.baseUrlOverride;

/**
 * Discovery: OpenAI / Anthropic / HuggingFace require a key (the stored handle
 * OR the pre-add plaintext key). OpenRouter's model catalog is public
 * (keyless by design — the AI Lab fetches it anonymously); local runtimes
 * (ollama / openai-compatible) need none. Mirrors the UI gate in
 * ProviderManager.canFetchForCurrentSelection so a compromised renderer can't
 * probe a keyless cloud discovery endpoint either.
 */
const requireDiscoveryKey = (v: { provider: string; apiKeyHandleId?: string; apiKey?: string }) => {
  const p = v.provider as Provider;
  if (p === 'openrouter' || isLocalProvider(p)) return true;
  return !!v.apiKeyHandleId || !!v.apiKey;
};

export const AiLabCompleteSchema = AiLabCompleteBase.extend({
  operationId: z.uuid(),
})
  .refine(requireBaseForCompat, {
    message: 'openai-compatible provider requires a base URL.',
    path: ['baseUrlOverride'],
  })
  .refine(requireInferenceKey, {
    message: 'This provider requires an API key. Add one in the provider settings.',
    path: ['apiKeyHandleId'],
  });

export const AiLabCompleteCancelSchema = z
  .object({
    operationId: z.uuid(),
  })
  .strict();

export const AiLabStreamSchema = AiLabCompleteBase.extend({
  streamId: z.uuid(),
})
  .refine(requireBaseForCompat, {
    message: 'openai-compatible provider requires a base URL.',
    path: ['baseUrlOverride'],
  })
  .refine(requireInferenceKey, {
    message: 'This provider requires an API key. Add one in the provider settings.',
    path: ['apiKeyHandleId'],
  });

export const AiLabStreamCancelSchema = z.object({ streamId: z.uuid() });

export const AiLabDiscoverSchema = z
  .object({
    provider: AiLabProviderSchema,
    baseUrl: z.url(),
    // A key already stored as a SecretRef handle (the typical path for an
    // already-added provider).
    apiKeyHandleId: z.uuid().optional(),
    // Plaintext key for the PRE-ADD discovery path: the user just typed a key in
    // the add-provider form and clicked "Fetch catalog" before committing. The
    // key has no handle yet (one is minted only on "Add provider"), so discovery
    // would otherwise run unauthenticated and 401 for key-required providers.
    // This is renderer→main IPC within the same Electron trust boundary; the key
    // is the user's own just-typed value, never a stored secret round-tripped
    // through the renderer. The handler prefers `apiKeyHandleId` when both are set.
    apiKey: z.string().max(4096).optional(),
  })
  .refine(requireDiscoveryKey, {
    message: 'This provider requires an API key to discover models.',
    path: ['apiKey'],
  });

const TelemetryTraceEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: z.string().min(1).max(200),
      type: z.literal('model.completed'),
      timestamp: z.number().nonnegative(),
      providerId: z.string().min(1).max(200),
      model: z.string().min(1).max(500),
      durationMs: z.number().nonnegative(),
      usage: z
        .object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() })
        .optional(),
      costUSD: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(200),
      type: z.literal('model.failed'),
      timestamp: z.number().nonnegative(),
      providerId: z.string().min(1).max(200),
      model: z.string().min(1).max(500),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(200),
      type: z.enum(['tool.completed', 'tool.failed']),
      timestamp: z.number().nonnegative(),
      toolName: z.string().min(1).max(500),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(200),
      type: z.literal('run.completed'),
      timestamp: z.number().nonnegative(),
      status: z.string().max(30),
    })
    .strict(),
]);

export const AiLabTelemetryExportSchema = z
  .object({
    config: AgentTelemetryConfigSchema,
    trace: z
      .object({
        id: z.string().min(1).max(200),
        suiteId: z.string().min(1).max(200),
        taskId: z.string().min(1).max(200),
        trial: z.number().int().positive(),
        agentId: z.string().min(1).max(200),
        startedAt: z.number().nonnegative(),
        finishedAt: z.number().nonnegative().optional(),
        events: z.array(TelemetryTraceEventSchema).max(1000),
      })
      .strict(),
  })
  .strict();
