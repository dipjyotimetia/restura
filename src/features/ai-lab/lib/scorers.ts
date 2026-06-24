// Scorers grade a single model completion against a dataset case. All scorers
// share ONE async signature so the runner treats deterministic checks and the
// LLM-as-judge identically: (config, ctx) => Promise<ScoreResult>.
//
// External capabilities the judge + script scorers need (an LLM call, the
// QuickJS sandbox) are injected via ScorerContext rather than imported here, so
// the deterministic scorers stay pure and unit-testable with no mocks.
import type { JudgeCriterion, JudgeRequestInput, JudgeVerdict } from '@shared/protocol/ai/judge';
import type { ChatToolCall, DatasetCase, ModelRef, ScorerConfig, ScoreResult } from '../types';

export interface ScriptScoreResult {
  passed: boolean;
  failures: string[];
}

/** Result of a pairwise comparison, injected by the runner for `pairwise` scorers. */
export interface PairwiseVerdict {
  /** 'A' = cell output wins, 'B' = baseline wins, 'tie'. */
  winner: 'A' | 'B' | 'tie';
  /** 0..1 preference score for the cell output (1 = clear win, 0.5 = tie). */
  score: number;
  reasoning: string;
}

export interface ScorerContext {
  output: string;
  testCase: DatasetCase;
  latencyMs: number;
  /** USD cost; null = unknown (unpriced model). */
  cost: number | null;
  usage?: { promptTokens: number; completionTokens: number };
  /** Structured tool calls from the completion (for the `tool-call` scorer). */
  toolCalls?: ChatToolCall[];
  /** Baseline output the cell is compared against (for the `pairwise` scorer). */
  baselineOutput?: string;
  /** Provided by the runner for `judge` scorers. Returns the aggregated verdict. */
  judge?: (args: { judgeModel: ModelRef; input: JudgeRequestInput }) => Promise<JudgeVerdict>;
  /** Provided by the runner for `pairwise` scorers. */
  pairwise?: (args: {
    judgeModel: ModelRef;
    outputA: string;
    outputB: string;
    passThreshold: number;
    criteria?: JudgeCriterion[];
    swapPositions?: boolean;
  }) => Promise<PairwiseVerdict>;
  /** Provided by the runner for `script` scorers (wraps QuickJS ScriptExecutor). */
  runScript?: (args: {
    code: string;
    output: string;
    latencyMs: number;
  }) => Promise<ScriptScoreResult>;
}

function pass(scorer: ScorerConfig, passed: boolean, detail?: string, score?: number): ScoreResult {
  return {
    scorerId: scorer.id,
    kind: scorer.kind,
    passed,
    ...(score !== undefined ? { score } : {}),
    ...(detail ? { detail } : {}),
  };
}

function expectedText(c: DatasetCase, from: 'expected' | 'reference'): string | undefined {
  return from === 'expected' ? c.expected : c.reference;
}

export async function runScorer(scorer: ScorerConfig, ctx: ScorerContext): Promise<ScoreResult> {
  switch (scorer.kind) {
    case 'exact-match': {
      const want = expectedText(ctx.testCase, scorer.expectedFrom);
      if (want === undefined)
        return pass(scorer, false, `case has no ${scorer.expectedFrom} value`);
      const a = scorer.caseInsensitive ? ctx.output.toLowerCase().trim() : ctx.output.trim();
      const b = scorer.caseInsensitive ? want.toLowerCase().trim() : want.trim();
      return pass(scorer, a === b);
    }
    case 'contains': {
      const hay = scorer.caseInsensitive ? ctx.output.toLowerCase() : ctx.output;
      const needle = scorer.caseInsensitive ? scorer.needle.toLowerCase() : scorer.needle;
      return pass(scorer, hay.includes(needle));
    }
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(scorer.pattern, scorer.flags ?? '');
      } catch (e) {
        return pass(scorer, false, `invalid regex: ${e instanceof Error ? e.message : String(e)}`);
      }
      return pass(scorer, re.test(ctx.output));
    }
    case 'json-valid': {
      try {
        JSON.parse(ctx.output);
        return pass(scorer, true);
      } catch {
        return pass(scorer, false, 'output is not valid JSON');
      }
    }
    case 'json-schema':
      return scoreJsonSchema(scorer, ctx);
    case 'latency':
      return pass(
        scorer,
        ctx.latencyMs <= scorer.maxMs,
        `${Math.round(ctx.latencyMs)}ms vs ${scorer.maxMs}ms`
      );
    case 'cost': {
      if (ctx.cost === null) return pass(scorer, false, 'cost unknown for this model');
      return pass(
        scorer,
        ctx.cost <= scorer.maxUSD,
        `$${ctx.cost.toFixed(5)} vs $${scorer.maxUSD}`
      );
    }
    case 'script': {
      if (!ctx.runScript) return pass(scorer, false, 'script runner unavailable');
      const res = await ctx.runScript({
        code: scorer.code,
        output: ctx.output,
        latencyMs: ctx.latencyMs,
      });
      return pass(scorer, res.passed, res.failures.join('; ') || undefined);
    }
    case 'tool-call':
      return scoreToolCall(scorer, ctx);
    case 'pairwise': {
      if (!ctx.pairwise) return pass(scorer, false, 'pairwise runner unavailable');
      const outputB =
        scorer.baseline === 'reference'
          ? (ctx.testCase.reference ?? '')
          : (ctx.baselineOutput ?? '');
      if (!outputB) {
        return pass(scorer, false, 'no baseline output to compare against');
      }
      try {
        const v = await ctx.pairwise({
          judgeModel: scorer.judgeModel,
          outputA: ctx.output,
          outputB,
          passThreshold: scorer.passThreshold,
          ...(scorer.criteria ? { criteria: scorer.criteria } : {}),
          ...(scorer.swapPositions !== undefined ? { swapPositions: scorer.swapPositions } : {}),
        });
        const detail = `${v.winner === 'A' ? 'output wins' : v.winner === 'B' ? 'baseline wins' : 'tie'}${v.reasoning ? ` — ${v.reasoning}` : ''}`;
        return pass(scorer, v.score >= scorer.passThreshold, detail, v.score);
      } catch (e) {
        return pass(
          scorer,
          false,
          `pairwise failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    case 'judge': {
      if (!ctx.judge) return pass(scorer, false, 'judge runner unavailable');
      try {
        const input: JudgeRequestInput = {
          output: ctx.output,
          passThreshold: scorer.passThreshold,
          ...(scorer.rubric !== undefined ? { rubric: scorer.rubric } : {}),
          ...(scorer.criteria ? { criteria: scorer.criteria } : {}),
          ...(scorer.samples !== undefined ? { samples: scorer.samples } : {}),
          ...(scorer.anchors ? { anchors: scorer.anchors } : {}),
          ...(ctx.testCase.reference !== undefined ? { reference: ctx.testCase.reference } : {}),
          vars: ctx.testCase.vars,
        };
        const v = await ctx.judge({ judgeModel: scorer.judgeModel, input });
        return {
          scorerId: scorer.id,
          kind: scorer.kind,
          passed: v.pass,
          score: v.score,
          ...(v.reasoning ? { detail: v.reasoning } : {}),
          ...(v.perCriterion ? { perCriterion: v.perCriterion } : {}),
          ...(v.variance !== undefined ? { variance: v.variance } : {}),
        };
      } catch (e) {
        return pass(scorer, false, `judge failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

async function scoreJsonSchema(
  scorer: Extract<ScorerConfig, { kind: 'json-schema' }>,
  ctx: ScorerContext
): Promise<ScoreResult> {
  let data: unknown;
  try {
    data = JSON.parse(ctx.output);
  } catch {
    return pass(scorer, false, 'output is not valid JSON');
  }
  const res = await validateAgainstSchema(data, scorer.schema);
  if (!res.ok) return pass(scorer, false, res.error);
  return pass(scorer, res.valid, res.valid ? undefined : 'output does not match schema');
}

/**
 * Lazily load Ajv and validate `data` against a stringified JSON Schema. Shared
 * by the json-schema and tool-call scorers. Fails closed on any load/compile
 * error. Returns `{ ok:false }` for an unusable schema (distinct from a clean
 * `{ ok:true, valid:false }` "data didn't match").
 */
async function validateAgainstSchema(
  data: unknown,
  schemaStr: string
): Promise<{ ok: true; valid: boolean } | { ok: false; error: string }> {
  let schema: object;
  try {
    schema = JSON.parse(schemaStr) as object;
  } catch {
    return { ok: false, error: 'scorer schema is not valid JSON' };
  }
  try {
    const mod = (await import('ajv')) as unknown as {
      default?: new (opts?: object) => { compile: (s: object) => (d: unknown) => boolean };
    } & { Ajv?: new (opts?: object) => { compile: (s: object) => (d: unknown) => boolean } };
    const Ctor = mod.default ?? mod.Ajv;
    if (!Ctor) return { ok: false, error: 'JSON-schema validator unavailable' };
    const ajv = new Ctor({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    return { ok: true, valid: validate(data) };
  } catch (e) {
    return {
      ok: false,
      error: `schema validation error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Score a tool/function call. Checks (in order): the expected tool was called;
 * its JSON arguments validate against `argsSchema`; the arguments deep-equal the
 * case's expected/reference JSON. Any configured check that fails fails the cell.
 */
async function scoreToolCall(
  scorer: Extract<ScorerConfig, { kind: 'tool-call' }>,
  ctx: ScorerContext
): Promise<ScoreResult> {
  const calls = ctx.toolCalls ?? [];
  if (calls.length === 0) return pass(scorer, false, 'model made no tool call');

  // Pick the matching call: by name if expectedTool is set, else the first call.
  const call = scorer.expectedTool ? calls.find((c) => c.name === scorer.expectedTool) : calls[0];
  if (!call) {
    return pass(
      scorer,
      false,
      `expected tool "${scorer.expectedTool}" not called (called: ${calls.map((c) => c.name).join(', ') || 'none'})`
    );
  }

  let args: unknown;
  try {
    args = call.input ? JSON.parse(call.input) : {};
  } catch {
    return pass(scorer, false, `tool "${call.name}" arguments are not valid JSON`);
  }

  if (scorer.argsSchema) {
    const res = await validateAgainstSchema(args, scorer.argsSchema);
    if (!res.ok) return pass(scorer, false, res.error);
    if (!res.valid) return pass(scorer, false, `tool "${call.name}" arguments do not match schema`);
  }

  if (scorer.expectedArgsFrom) {
    const wantText = expectedText(ctx.testCase, scorer.expectedArgsFrom);
    if (wantText === undefined) {
      return pass(
        scorer,
        false,
        `case has no ${scorer.expectedArgsFrom} value to match args against`
      );
    }
    let want: unknown;
    try {
      want = JSON.parse(wantText);
    } catch {
      return pass(scorer, false, `case ${scorer.expectedArgsFrom} is not valid JSON`);
    }
    if (!deepEqual(args, want)) {
      return pass(scorer, false, `tool "${call.name}" arguments do not match expected`);
    }
  }

  return pass(scorer, true, `called "${call.name}"`);
}

/** Order-insensitive structural equality for JSON values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}
