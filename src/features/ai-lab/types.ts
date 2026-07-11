// AI Lab domain types (Electron-only). The wire/provider types live in
// shared/protocol/ai; these are the renderer-side workbench models persisted in
// the aiLab / evalRuns Dexie tables.
import type { CriterionVerdict, JudgeAnchor, JudgeCriterion } from '@shared/protocol/ai/judge';
import type { AiToolDef, ChatToolCall, Provider } from '@shared/protocol/ai/types';

export type { CriterionVerdict, JudgeAnchor, JudgeCriterion };
export type { AiToolDef, ChatToolCall };

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
   * Ollama (free/local) and arbitrary OpenAI-compatible gateways — the UI shows
   * cost as "free"/"unknown" rather than a misleading $0.00.
   */
  pricingKnown: boolean;
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

/** A concrete model selection: which provider config + which model id. */
export interface ModelRef {
  providerConfigId: string;
  model: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  /** System prompt; `{{var}}` placeholders allowed. */
  system: string;
  /** User prompt; `{{var}}` placeholders resolved from a dataset case's vars. */
  user: string;
  createdAt: number;
  updatedAt: number;
}

/** One turn in a multi-turn conversation case. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DatasetCase {
  id: string;
  vars: Record<string, string>;
  /** Optional gold/reference output (for reference-based scorers + judge). */
  reference?: string;
  /** Optional exact expected output (for exact-match). */
  expected?: string;
  /**
   * Optional multi-turn conversation. When present, the runner builds the
   * model messages from these turns (with `{{var}}` still resolved against
   * `vars`) instead of the prompt template's single user message. The prompt's
   * `system` message is still prepended.
   */
  turns?: ConversationTurn[];
}

export interface Dataset {
  id: string;
  name: string;
  cases: DatasetCase[];
  createdAt: number;
  updatedAt: number;
}

// --- Scorers ---------------------------------------------------------------
export type ScorerKind =
  | 'exact-match'
  | 'contains'
  | 'regex'
  | 'json-valid'
  | 'json-schema'
  | 'latency'
  | 'cost'
  | 'script'
  | 'judge'
  | 'tool-call'
  | 'pairwise';

interface ScorerBase {
  id: string;
  kind: ScorerKind;
  /** Display label (defaults to the kind). */
  label?: string;
}

export type ScorerConfig =
  | (ScorerBase & {
      kind: 'exact-match';
      expectedFrom: 'expected' | 'reference';
      caseInsensitive?: boolean;
    })
  | (ScorerBase & { kind: 'contains'; needle: string; caseInsensitive?: boolean })
  | (ScorerBase & { kind: 'regex'; pattern: string; flags?: string })
  | (ScorerBase & { kind: 'json-valid' })
  | (ScorerBase & { kind: 'json-schema'; schema: string })
  | (ScorerBase & { kind: 'latency'; maxMs: number })
  | (ScorerBase & { kind: 'cost'; maxUSD: number })
  | (ScorerBase & { kind: 'script'; code: string })
  | (ScorerBase & {
      kind: 'judge';
      judgeModel: ModelRef;
      passThreshold: number;
      /** Legacy single-criterion rubric. Ignored when `criteria` is set. */
      rubric?: string;
      /** Multi-criteria weighted rubric (each criterion scored independently). */
      criteria?: JudgeCriterion[];
      /** Self-consistency: run the judge N times and aggregate (median + variance). */
      samples?: number;
      /** Calibration examples that pin the 0–1 scale. */
      anchors?: JudgeAnchor[];
    })
  | (ScorerBase & {
      kind: 'tool-call';
      /** Name the model must have called. Empty = any tool call passes. */
      expectedTool?: string;
      /** JSON Schema (stringified) the called tool's `input` must validate against. */
      argsSchema?: string;
      /** Compare the called args to the case's expected/reference JSON, if set. */
      expectedArgsFrom?: 'expected' | 'reference';
    })
  | (ScorerBase & {
      kind: 'pairwise';
      judgeModel: ModelRef;
      /** Compare the cell output against the case reference. */
      baseline: 'reference';
      passThreshold: number;
      /** Multi-criteria rubric for the comparison (optional). */
      criteria?: JudgeCriterion[];
      /** Run both A/B orderings and cancel position bias. */
      swapPositions?: boolean;
    });

/**
 * What a cell scores. `text` (default) scores the model completion directly.
 * `http-exec` parses an HTTP/GraphQL request out of the completion, executes it
 * through the real request executor, and scores the upstream response instead.
 */
export type EvalTarget =
  | { kind: 'text' }
  | {
      kind: 'http-exec';
      /** How to pull the request spec out of the model output. */
      parseFrom: 'json' | 'fenced';
      protocol: 'http' | 'graphql';
    };

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
  createdAt: number;
  updatedAt: number;
}

// --- Run results -----------------------------------------------------------
export interface ScoreResult {
  scorerId: string;
  kind: ScorerKind;
  passed: boolean;
  /** Numeric score where meaningful (judge 0–1, others omit). */
  score?: number;
  detail?: string;
  /** Per-criterion breakdown (judge scorer with criteria). */
  perCriterion?: CriterionVerdict[];
  /** Population variance of the judge score across self-consistency samples. */
  variance?: number;
}

/** Summary of an executed upstream request (http-exec target). */
export interface ExecutedSummary {
  status: number;
  latencyMs: number;
  /** Truncated response body (full body feeds the scorers via `output`). */
  bodyExcerpt: string;
  ok: boolean;
}

export interface EvalCellResult {
  caseId: string;
  modelRef: ModelRef;
  output: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number };
  /** USD cost; null = unknown (unpriced gateway/compat model). */
  cost: number | null;
  scores: ScoreResult[];
  /** True iff every scorer passed and the model call succeeded. */
  passed: boolean;
  /**
   * True when the cell ran with NO scorers configured — it neither passed nor
   * failed, it was simply not evaluated. The UI surfaces this distinctly so a
   * misconfigured eval can't read as 100% green.
   */
  notEvaluated?: boolean;
  /** Present for `http-exec` targets: the executed upstream response summary. */
  executed?: ExecutedSummary;
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
  cells: EvalCellResult[];
  totalCells: number;
}

// --- Arena (pairwise leaderboard) ------------------------------------------
/** One head-to-head result between two model keys (providerConfigId:model). */
export interface ArenaMatch {
  a: string;
  b: string;
  winner: 'a' | 'b' | 'tie';
}

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
  status: EvalRunStatus;
}
