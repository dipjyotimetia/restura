// Scorers grade a single model completion against a dataset case. All scorers
// share ONE async signature so the runner treats deterministic checks and the
// LLM-as-judge identically: (config, ctx) => Promise<ScoreResult>.
//
// External capabilities the judge + script scorers need (an LLM call, the
// QuickJS sandbox) are injected via ScorerContext rather than imported here, so
// the deterministic scorers stay pure and unit-testable with no mocks.
import type { DatasetCase, ModelRef, ScorerConfig, ScoreResult } from '../types';

export interface JudgeResult {
  score: number; // 0..1
  reasoning: string;
  pass: boolean;
}

export interface ScriptScoreResult {
  passed: boolean;
  failures: string[];
}

export interface ScorerContext {
  output: string;
  testCase: DatasetCase;
  latencyMs: number;
  /** USD cost; null = unknown (unpriced model). */
  cost: number | null;
  usage?: { promptTokens: number; completionTokens: number };
  /** Provided by the runner for `judge` scorers. */
  judge?: (args: {
    judgeModel: ModelRef;
    rubric: string;
    passThreshold: number;
    output: string;
    testCase: DatasetCase;
  }) => Promise<JudgeResult>;
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
    case 'judge': {
      if (!ctx.judge) return pass(scorer, false, 'judge runner unavailable');
      try {
        const r = await ctx.judge({
          judgeModel: scorer.judgeModel,
          rubric: scorer.rubric,
          passThreshold: scorer.passThreshold,
          output: ctx.output,
          testCase: ctx.testCase,
        });
        return pass(scorer, r.pass, r.reasoning, r.score);
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
  let schema: object;
  try {
    schema = JSON.parse(scorer.schema) as object;
  } catch {
    return pass(scorer, false, 'scorer schema is not valid JSON');
  }
  try {
    const mod = (await import('ajv')) as unknown as {
      default?: new (opts?: object) => { compile: (s: object) => (d: unknown) => boolean };
    } & { Ajv?: new (opts?: object) => { compile: (s: object) => (d: unknown) => boolean } };
    const Ctor = mod.default ?? mod.Ajv;
    if (!Ctor) return pass(scorer, false, 'JSON-schema validator unavailable');
    const ajv = new Ctor({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const ok = validate(data);
    return pass(scorer, ok, ok ? undefined : 'output does not match schema');
  } catch (e) {
    // Invalid schema (ajv.compile throws) or a load failure — fail closed.
    return pass(
      scorer,
      false,
      `schema validation error: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
