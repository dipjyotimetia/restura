// AI Lab domain types (Electron-only). The wire/provider types live in
// shared/protocol/ai; these are the renderer-side workbench models persisted in
// the aiLab / evalRuns Dexie tables.
import type { Provider } from '@shared/protocol/ai/types';
import type { CriterionVerdict, JudgeAnchor, JudgeCriterion } from '@shared/protocol/ai/judge';

export type { CriterionVerdict, JudgeAnchor, JudgeCriterion };

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
  createdAt: number;
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

export interface DatasetCase {
  id: string;
  vars: Record<string, string>;
  /** Optional gold/reference output (for reference-based scorers + judge). */
  reference?: string;
  /** Optional exact expected output (for exact-match). */
  expected?: string;
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
  | 'judge';

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
    });

export interface EvalConfig {
  id: string;
  name: string;
  promptId: string;
  datasetId: string;
  models: ModelRef[];
  scorers: ScorerConfig[];
  /** Renderer-side fan-out cap (main enforces its own hard ceiling). */
  concurrency: number;
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
}

export type EvalRunStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface EvalRun {
  id: string;
  evalConfigId: string;
  configName: string;
  startedAt: number;
  finishedAt?: number;
  status: EvalRunStatus;
  cells: EvalCellResult[];
  totalCells: number;
}
