// AI Lab domain types (Electron-only). The wire/provider types live in
// shared/protocol/ai; these are the renderer-side workbench models persisted in
// the aiLab / evalRuns Dexie tables.
import type { ModelCapabilities } from '@shared/agent-lab';
import type { CriterionVerdict, JudgeAnchor, JudgeCriterion } from '@shared/protocol/ai/judge';
import type { AiToolDef, ChatToolCall, Provider } from '@shared/protocol/ai/types';

export type {
  ConversationTurn,
  Dataset,
  DatasetCase,
  EvalCellResult,
  EvalTarget,
  ExecutedSummary,
  ModelRef,
  PromptTemplate,
  ScoreResult,
  ScorerConfig,
  ScorerKind,
} from '@shared/ai-lab/types';
export type { AiToolDef, ChatToolCall, CriterionVerdict, JudgeAnchor, JudgeCriterion };

import type { EvalCellResult, EvalTarget, ModelRef, ScorerConfig } from '@shared/ai-lab/types';

/**
 * A user-configured provider instance. One row per endpoint the user adds —
 * a local Ollama, a hosted gateway, a cloud key. The API key is never stored
 * in plaintext: `apiKeyHandleId` references a SecretRef handle resolved in main.
 */
export interface AiLabProviderConfig {
  id: string;
  provider: Provider;
  /** User-facing name, e.g. "Local Ollama" or "Groq". */
  label: string;
  /** Base URL for local / openai-compatible (and any cloud override). */
  baseUrl?: string;
  /** SecretRef handle id; absent for keyless local runtimes. */
  apiKeyHandleId?: string;
  /**
   * Whether per-token pricing is known for this provider's models. False for
   * providers without exact per-model prices. This never implies free usage;
   * zero cost requires an explicit `local-zero` assertion.
   */
  pricingKnown: boolean;
  /** User-asserted cost classification. Missing legacy values resolve to unknown. */
  costPolicy?: 'unknown' | 'local-zero';
  /** Convenience flag mirroring isLocalProvider(provider); drives the SSRF carve-out UX. */
  isLocal: boolean;
  /** Discovered or hand-entered model ids. */
  models: string[];
  /**
   * Per-model metadata captured at the most recent discovery. Only populated
   * for providers whose discovery endpoint returns rich fields (today:
   * OpenRouter — name, context length, modality, pricing). Undefined for
   * providers whose discovery only returns ids; the UI falls back to the id.
   * Transient in spirit (re-discovered on demand) but persisted so the
   * Playground / Eval model checklist can show context length + modality
   * without an extra round trip.
   */
  modelDetails?: Record<string, AiLabModelDetail>;
  /** Full per-model profiles explicitly asserted by the user. */
  capabilityOverrides?: Record<string, ModelCapabilities>;
  /**
   * Outcome of the most recent connection test, persisted so the provider
   * card can show a durable "tested ✓ 2m ago" instead of only a transient
   * toast. Absent until the user runs a test.
   */
  lastTest?: { ok: boolean; at: number; modelCount?: number; error?: string };
  /** Timestamp of the most recent successful model catalog discovery. */
  lastDiscoveredAt?: number;
  createdAt: number;
}

/**
 * Renderer-side subset of the shared `DiscoveredModel` — just the fields we
 * surface in the model checklist. Kept in the feature types so the renderer
 * doesn't depend on the shared/protocol wire shape (the shared type has more
 * fields reserved for future use).
 */
export interface AiLabModelDetail {
  /** Human-readable name, e.g. "Claude 3.5 Sonnet". */
  label?: string;
  /** Short model description, surfaced as a tooltip (OpenRouter). */
  description?: string;
  /** Max context window in tokens (OpenRouter). */
  contextLength?: number;
  /** Modality string, e.g. "text+image->text" (OpenRouter). */
  modality?: string;
  /** Per-million-token USD prices (OpenRouter). */
  pricing?: {
    promptPerMTokUSD?: number;
    completionPerMTokUSD?: number;
    /** Price of prompt tokens served from the provider's cache. */
    cacheReadPerMTokUSD?: number;
    /** Price of prompt tokens written to the provider's cache. */
    cacheWritePerMTokUSD?: number;
  };
  /** Model-specific capabilities returned by a tested discovery adapter. */
  agentCapabilities?: Partial<ModelCapabilities>;
  /** Identifies the tested adapter that produced `agentCapabilities`. */
  agentCapabilityProvenance?: {
    source: 'discovered';
    adapterId: 'openrouter.models';
    adapterVersion: 1;
  };
  /** ISO 8601 created timestamp, normalised at parse time. */
  createdAt?: string;
  /**
   * Provider/owner label. OpenAI's `owned_by` ("openai"), Anthropic hardcoded
   * to "anthropic", OpenRouter's upstream vendor ("anthropic" / "openai"),
   * Ollama's `details.family` ("llama" / "qwen2"). Shown as a small subtitle.
   */
  vendor?: string;
  // Ollama-specific.
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  /** Model file size in bytes (Ollama). */
  sizeBytes?: number;
  /** ISO 8601 last-modified timestamp (Ollama). */
  modifiedAt?: string;
}

export interface EvalConfig {
  id: string;
  name: string;
  promptId: string;
  datasetId: string;
  models: ModelRef[];
  scorers: ScorerConfig[];
  /** Renderer-side fan-out cap (main enforces its own hard ceiling). */
  concurrency: number;
  /** What the cell scores. Defaults to `{ kind: 'text' }` when absent. */
  target?: EvalTarget;
  /** Tool definitions exposed to the model (enables the tool-call scorer). */
  tools?: AiToolDef[];
  /** Visible per-suite override: skip the secret check for cloud providers (default off). */
  sendUnredactedToCloud?: boolean;
  /** Fraction (0-1) of scored cells that must pass for the run to read `passed`. Default 1. */
  passThreshold?: number;
  createdAt: number;
  updatedAt: number;
}

export type EvalRunStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface EvalRun {
  id: string;
  evalConfigId: string;
  configName: string;
  /** Dataset the run executed against (for case-var lookups in reports). */
  datasetId?: string;
  datasetName?: string;
  /**
   * Human-readable label per `providerConfigId:model` key, captured at run
   * start so reports keep friendly names even if the provider is later
   * renamed or removed.
   */
  modelLabels?: Record<string, string>;
  startedAt: number;
  finishedAt?: number;
  status: EvalRunStatus;
  /** Set when the app closed mid-run; restored as `cancelled` and labelled 'interrupted'. */
  interrupted?: boolean;
  /** Pass threshold in force when the run started; absent on runs that predate it. */
  passThreshold?: number;
  cells: EvalCellResult[];
  totalCells: number;
}

// --- Arena (pairwise leaderboard) ------------------------------------------
/** One head-to-head result between two model keys (providerConfigId:model). */
export interface ArenaMatch {
  a: string;
  b: string;
  /** 'error' = a contestant or the judge failed; excluded from Elo, shown as an error. */
  winner: 'a' | 'b' | 'tie' | 'error';
  error?: string;
}

/** Arena adds `partial` (some matches errored) to the shared run statuses. */
export type ArenaRunStatus = EvalRunStatus | 'partial';

export interface ArenaRun {
  id: string;
  datasetId: string;
  datasetName: string;
  /** Contestant model keys, in entry order. */
  modelKeys: string[];
  /** Human-readable label per model key. */
  modelLabels: Record<string, string>;
  matches: ArenaMatch[];
  startedAt: number;
  finishedAt?: number;
  status: ArenaRunStatus;
  /** Set when the app closed mid-run; restored as `cancelled` and labelled 'interrupted'. */
  interrupted?: boolean;
}
