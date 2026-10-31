// AI Lab dataset-eval domain types shared by the desktop workbench and
// `restura eval run`. Runtime-neutral: no renderer, IPC or storage concerns.
import type { CriterionVerdict, JudgeAnchor, JudgeCriterion } from '../protocol/ai/judge';

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
  /**
   * Optional held-out marker. Cases tagged `test` are the held-out set: hillclimb a
   * prompt against the `train` cases and read the `test` cases only to confirm, so a
   * prompt tuned to the cases you looked at cannot masquerade as a better prompt
   * (train up, test flat is overfitting). Untagged cases count as train.
   */
  split?: 'train' | 'test';
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
