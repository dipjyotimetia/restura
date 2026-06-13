// Backend-agnostic LLM-as-judge engine. Single source of truth for judge
// prompt-building, verdict-parsing, and aggregation across the repo. We force
// the judge to call a tool (provider JSON/tool mode, already supported by the
// shared orchestrator) rather than regex-parsing prose — a free-text score is
// brittle and easily mis-extracted.
//
// Hardening (multi-criteria weighted rubrics with gates, self-consistency
// sampling, calibration anchors) lives here so BOTH consumers — AI Lab evals
// and `rs.judge` in the script sandbox — upgrade from one change. The legacy
// single-`rubric` path is preserved verbatim for back-compat.
//
// Depends ONLY on shared/protocol/ai/types — never on anything under
// src/features/. Consumers (AI Lab eval runner, rs.judge bridge) inject only
// transport via runJudge.
import type { ChatMessageWire, CompletionResult } from './types';
import { extractFirstJsonObject } from './json-extract';

/** Max self-consistency samples. Caps cost: each sample is a full judge call. */
export const MAX_JUDGE_SAMPLES = 5;

/** Default pass bar when the caller doesn't supply one. */
export const DEFAULT_PASS_THRESHOLD = 0.5;

/** Legacy single-criterion tool. Kept for back-compat callers/tests. */
export const JUDGE_TOOL = {
  name: 'submit_judgment',
  description: 'Submit your structured evaluation of the candidate answer.',
  inputSchema: {
    type: 'object',
    properties: {
      score: { type: 'number', description: 'Quality from 0.0 (worst) to 1.0 (best).' },
      reasoning: { type: 'string', description: 'Brief justification for the score.' },
      pass: { type: 'boolean', description: 'Whether the answer meets the bar.' },
    },
    required: ['score', 'reasoning', 'pass'],
  },
} as const;

/** One axis of evaluation. Multiple criteria are scored independently. */
export interface JudgeCriterion {
  name: string;
  rubric: string;
  /** Relative weight in the aggregate score. Default 1. */
  weight?: number;
  /** A failing gate criterion fails the whole verdict regardless of weighted score. */
  gate?: boolean;
}

/** A reference-scored example that anchors the 0–1 scale for the judge. */
export interface JudgeAnchor {
  output: string;
  score: number;
  note?: string;
}

/** Generic, ai-lab-decoupled input for running a judge. */
export interface JudgeRequestInput {
  output: string;
  reference?: string;
  vars?: Record<string, string>;
  passThreshold?: number;
  /** Legacy single-criterion rubric. Ignored when `criteria` is provided. */
  rubric?: string;
  /** Multi-criteria rubric. Each criterion is scored independently. */
  criteria?: JudgeCriterion[];
  /** Self-consistency: run the judge N times and aggregate. Default 1 (clamped to MAX_JUDGE_SAMPLES). */
  samples?: number;
  /** Calibration examples that pin the 0–1 scale. */
  anchors?: JudgeAnchor[];
}

/** Per-criterion result, present on verdicts produced with explicit criteria. */
export interface CriterionVerdict {
  name: string;
  score: number;
  pass: boolean;
  reasoning: string;
}

/** The structured verdict a judge run is parsed/aggregated into. */
export interface JudgeVerdict {
  pass: boolean;
  score: number;
  reasoning: string;
  /** Present when the judge ran with explicit criteria. */
  perCriterion?: CriterionVerdict[];
  /** Population variance of the overall score across samples (0 for a single sample). */
  variance?: number;
  /** Number of judge calls aggregated. */
  samples?: number;
}

/** Transport injected by callers: builds the request, calls the model, returns a completion. */
export type JudgeComplete = (
  messages: ChatMessageWire[],
  tools: unknown[]
) => Promise<CompletionResult>;

/** Collapse an input to a concrete criteria list (single rubric → one `overall` criterion). */
export function normalizeCriteria(input: {
  rubric?: string;
  criteria?: JudgeCriterion[];
}): JudgeCriterion[] {
  if (input.criteria && input.criteria.length > 0) return input.criteria;
  return [{ name: 'overall', rubric: input.rubric ?? '', weight: 1 }];
}

/** Build the per-criterion judge tool. Schema requires one entry per criterion. */
export function buildJudgeTool(criteria: JudgeCriterion[]) {
  return {
    name: JUDGE_TOOL.name,
    description:
      'Submit your per-criterion evaluation of the candidate answer. Return exactly one ' +
      `entry for each criterion: ${criteria.map((c) => c.name).join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        criteria: {
          type: 'array',
          description: 'One entry per evaluation criterion, in the order given.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              score: { type: 'number', description: '0.0 (worst) to 1.0 (best).' },
              pass: { type: 'boolean', description: 'Whether this criterion meets the bar.' },
              reasoning: { type: 'string', description: 'Brief justification for this criterion.' },
            },
            required: ['name', 'score', 'pass', 'reasoning'],
          },
        },
        overall_reasoning: { type: 'string', description: 'Optional summary across criteria.' },
      },
      required: ['criteria'],
    },
  } as const;
}

/**
 * Build the judge prompt messages. With `criteria`, renders a multi-criteria
 * prompt (+ optional calibration anchors). Without, falls back to the original
 * single-`rubric` format verbatim — existing callers/tests are unaffected.
 */
export function buildJudgeMessages(args: {
  rubric?: string;
  criteria?: JudgeCriterion[];
  output: string;
  reference?: string;
  vars?: Record<string, string>;
  anchors?: JudgeAnchor[];
  passThreshold: number;
}): ChatMessageWire[] {
  const vars = args.vars ?? {};
  const varsBlock = Object.keys(vars).length
    ? `\n\nInput variables:\n${JSON.stringify(vars, null, 2)}`
    : '';
  const refBlock = args.reference ? `\n\nReference answer:\n${args.reference}` : '';

  // Legacy single-rubric path — preserved verbatim for back-compat.
  if (!args.criteria || args.criteria.length === 0) {
    const system =
      'You are a strict, impartial evaluator of AI model outputs. Read the rubric and the ' +
      'candidate answer, then call the submit_judgment tool. Score from 0.0 to 1.0. ' +
      `Set pass=true only if the answer meets the rubric (treat score >= ${args.passThreshold} as the bar). ` +
      'Do not be swayed by confident tone; judge substance.';
    const user =
      `Rubric:\n${args.rubric ?? ''}` +
      varsBlock +
      refBlock +
      `\n\nCandidate answer:\n${args.output}\n\nEvaluate the candidate answer now.`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  // Multi-criteria path.
  const system =
    'You are a strict, impartial evaluator of AI model outputs. Evaluate the candidate answer ' +
    'against EACH criterion independently, then call the submit_judgment tool with one entry per ' +
    `criterion. Score each from 0.0 to 1.0 and treat score >= ${args.passThreshold} as the bar for ` +
    'that criterion. Criteria marked REQUIRED must pass. Do not be swayed by confident tone; judge substance.';

  const criteriaBlock = args.criteria
    .map((c, i) => {
      const tags = [
        c.weight !== undefined && c.weight !== 1 ? `weight ${c.weight}` : null,
        c.gate ? 'REQUIRED' : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `${i + 1}. ${c.name}${tags ? ` (${tags})` : ''}: ${c.rubric}`;
    })
    .join('\n');

  const anchorsBlock = args.anchors?.length
    ? `\n\nCalibration examples (for scale reference only):\n` +
      args.anchors
        .map((a) => `- score ${a.score}: ${a.output}${a.note ? ` — ${a.note}` : ''}`)
        .join('\n')
    : '';

  const user =
    `Criteria:\n${criteriaBlock}` +
    anchorsBlock +
    varsBlock +
    refBlock +
    `\n\nCandidate answer:\n${args.output}\n\nEvaluate the candidate answer now.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Parse a verdict from a judge completion. The 2-arg form preserves the
 * original single-criterion behavior verbatim (back-compat). Passing `criteria`
 * switches to per-criterion parsing with weighted aggregation + gates.
 */
export function parseJudgment(
  completion: CompletionResult,
  passThreshold: number,
  criteria?: JudgeCriterion[]
): JudgeVerdict {
  const raw =
    completion.toolCalls.find((t) => t.name === JUDGE_TOOL.name)?.input ??
    extractFirstJsonObject(completion.text);
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  // Legacy single-criterion shape — unchanged.
  if (!criteria || criteria.length === 0) {
    const score = clamp01(toNumber(parsed.score));
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
    const pass = typeof parsed.pass === 'boolean' ? parsed.pass : score >= passThreshold;
    return { score, reasoning, pass };
  }

  // Multi-criteria: prefer the per-criterion array; fall back to a flat shape
  // (older/smaller models) applied across criteria.
  const entries = Array.isArray(parsed.criteria)
    ? (parsed.criteria as Array<Record<string, unknown>>)
    : [];
  const byName = new Map(
    entries.filter((e) => e && typeof e.name === 'string').map((e) => [e.name as string, e])
  );
  const perCriterion: CriterionVerdict[] = criteria.map((c, i) => {
    const e = byName.get(c.name) ?? entries[i] ?? (entries.length === 0 ? parsed : undefined);
    const score = clamp01(toNumber(e?.score));
    const pass = typeof e?.pass === 'boolean' ? e.pass : score >= passThreshold;
    const reasoning = typeof e?.reasoning === 'string' ? e.reasoning : '';
    return { name: c.name, score, pass, reasoning };
  });

  const score = weightedMean(
    perCriterion.map((p) => p.score),
    criteria.map((c) => c.weight ?? 1)
  );
  const gatesPass = criteria.every((c, i) => !c.gate || perCriterion[i]!.pass);
  const pass = score >= passThreshold && gatesPass;
  const reasoning =
    typeof parsed.overall_reasoning === 'string' && parsed.overall_reasoning
      ? parsed.overall_reasoning
      : summarizeReasoning(perCriterion);
  return { score, reasoning, pass, perCriterion };
}

/**
 * Aggregate self-consistency samples into one verdict: per-criterion median
 * score, weighted overall, gate-aware pass, and the population variance of the
 * overall score across samples. A single sample returns as-is (variance 0).
 */
export function aggregateVerdicts(
  verdicts: JudgeVerdict[],
  criteria: JudgeCriterion[],
  passThreshold: number
): JudgeVerdict {
  const first = verdicts[0];
  if (!first)
    return { pass: false, score: 0, reasoning: 'no judge samples', variance: 0, samples: 0 };
  if (verdicts.length === 1) return { ...first, variance: 0, samples: 1 };

  const perCriterion: CriterionVerdict[] = criteria.map((c) => {
    const scores = verdicts.map((v) => v.perCriterion?.find((p) => p.name === c.name)?.score ?? 0);
    const score = median(scores);
    return {
      name: c.name,
      score,
      pass: score >= passThreshold,
      reasoning: closestReasoning(verdicts, c.name, score),
    };
  });
  const score = weightedMean(
    perCriterion.map((p) => p.score),
    criteria.map((c) => c.weight ?? 1)
  );
  const gatesPass = criteria.every((c, i) => !c.gate || perCriterion[i]!.pass);
  const pass = score >= passThreshold && gatesPass;
  const variance = populationVariance(verdicts.map((v) => v.score));
  return {
    score,
    reasoning: summarizeReasoning(perCriterion),
    pass,
    perCriterion,
    variance,
    samples: verdicts.length,
  };
}

/**
 * Run a judge end-to-end: normalize criteria, build the prompt + tool, sample
 * `samples` times via the injected `complete`, and aggregate. The whole judging
 * algorithm lives here; callers supply only transport (IPC / completeLlm).
 */
export async function runJudge(
  input: JudgeRequestInput,
  complete: JudgeComplete
): Promise<JudgeVerdict> {
  const passThreshold = input.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const criteria = normalizeCriteria(input);
  const tool = buildJudgeTool(criteria);
  const messages = buildJudgeMessages({
    criteria,
    output: input.output,
    passThreshold,
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
    ...(input.vars ? { vars: input.vars } : {}),
    ...(input.anchors ? { anchors: input.anchors } : {}),
  });

  const requested = Math.floor(input.samples ?? 1);
  const samples = Number.isFinite(requested)
    ? Math.max(1, Math.min(requested, MAX_JUDGE_SAMPLES))
    : 1;

  const verdicts: JudgeVerdict[] = [];
  for (let i = 0; i < samples; i++) {
    const completion = await complete(messages, [tool]);
    if (!completion.ok) {
      throw new Error(completion.error?.message ?? 'judge model call failed');
    }
    verdicts.push(parseJudgment(completion, passThreshold, criteria));
  }
  return aggregateVerdicts(verdicts, criteria, passThreshold);
}

// --- helpers ---------------------------------------------------------------

function toNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function weightedMean(values: number[], weights: number[]): number {
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i] ?? 1;
    sum += (values[i] ?? 0) * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function populationVariance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
}

/** One reasoning line for a single criterion; `name: reasoning` joined for several. */
function summarizeReasoning(perCriterion: CriterionVerdict[]): string {
  if (perCriterion.length === 1) return perCriterion[0]!.reasoning;
  return perCriterion
    .filter((p) => p.reasoning)
    .map((p) => `${p.name}: ${p.reasoning}`)
    .join(' | ');
}

/** Reasoning from the sample whose criterion score is nearest the aggregate. */
function closestReasoning(verdicts: JudgeVerdict[], name: string, target: number): string {
  let best = '';
  let bestDiff = Infinity;
  for (const v of verdicts) {
    const p = v.perCriterion?.find((x) => x.name === name);
    if (!p) continue;
    const d = Math.abs(p.score - target);
    if (d < bestDiff) {
      bestDiff = d;
      best = p.reasoning;
    }
  }
  return best;
}
