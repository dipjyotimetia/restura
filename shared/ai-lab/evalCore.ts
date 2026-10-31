// Runtime-neutral dataset-eval core: case × model cells through a bounded
// pool, retry on transient failures, scoring, judges and the http-exec target.
// The desktop (IPC to Electron main) and `restura eval run` (direct fetch)
// differ only in the injected EvalModelPort, so both score identically.
import { type JudgeComplete, runJudge, runPairwiseJudge } from '../protocol/ai/judge';
import type { AiToolDef, ChatMessageWire, CompletionResult, Usage } from '../protocol/ai/types';
import { completeWithRetry } from './completeRetry';
import { runPool } from './concurrencyPool';
import { sameModelRef, selfJudgingMessage } from './judgePolicy';
import { renderTemplate } from './promptTemplate';
import { extractGraphqlSpec, extractRequestSpec } from './requestExtractor';
import { runScorer, type ScorerContext, type ScriptScoreResult } from './scorers';
import type {
  Dataset,
  DatasetCase,
  EvalCellResult,
  EvalTarget,
  ModelRef,
  PromptTemplate,
  ScorerConfig,
} from './types';

/** Normalized result of executing an extracted request (http-exec target). */
export interface ExecResult {
  status: number;
  statusText: string;
  /** Response body text (becomes the scoring `output`). */
  body: string;
  latencyMs: number;
  ok: boolean;
}

/** Injected executor for the `http-exec` target (desktop wraps the request executor). */
export type RunRequestFn = (
  req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  },
  signal?: AbortSignal
) => Promise<ExecResult>;

export type RunScriptFn = (args: {
  code: string;
  output: string;
  latencyMs: number;
}) => Promise<ScriptScoreResult>;

/** The only platform-specific part of an eval: how one model call is made and priced. */
export interface EvalModelPort {
  /** Whether the model's provider is configured (unknown providers fail their cells). */
  has(model: ModelRef): boolean;
  /** One model call; the core adds retry. May throw or return `ok: false`. */
  complete(
    model: ModelRef,
    messages: ChatMessageWire[],
    options: { tools?: AiToolDef[]; signal: AbortSignal }
  ): Promise<CompletionResult>;
  /** USD cost of a completion; null = unknown (an unpriced model is never free). */
  cost(model: ModelRef, usage: Usage | undefined): number | null;
}

/** Excerpt cap for the stored executed-response summary. */
const EXEC_EXCERPT_LIMIT = 2000;

export interface EvalCoreInput {
  prompt: Pick<PromptTemplate, 'system' | 'user'>;
  dataset: Pick<Dataset, 'cases'>;
  models: ModelRef[];
  scorers: ScorerConfig[];
  concurrency: number;
  port: EvalModelPort;
  /** Tool definitions exposed to the model (enables the tool-call scorer). */
  tools?: AiToolDef[];
  /** What each cell scores. Defaults to scoring the model text. */
  target?: EvalTarget;
  /** Executor for the `http-exec` target. Required when target is http-exec. */
  runRequest?: RunRequestFn;
  /** QuickJS runner for `script` scorers. */
  runScript?: RunScriptFn;
}

export interface EvalProgress {
  completed: number;
  total: number;
  cells: EvalCellResult[];
  done: boolean;
}

export function buildEvalMessages(
  prompt: Pick<PromptTemplate, 'system' | 'user'>,
  c: DatasetCase
): ChatMessageWire[] {
  const messages: ChatMessageWire[] = [];
  const system = renderTemplate(prompt.system, c.vars).trim();
  if (system) messages.push({ role: 'system', content: system });
  // Multi-turn case: replay the conversation (vars still resolved per turn).
  if (c.turns && c.turns.length > 0) {
    for (const t of c.turns) {
      messages.push({ role: t.role, content: renderTemplate(t.content, c.vars) });
    }
    return messages;
  }
  messages.push({ role: 'user', content: renderTemplate(prompt.user, c.vars) });
  return messages;
}

/** Score one completed cell against all configured scorers. */
async function scoreCell(
  scorers: ScorerConfig[],
  ctx: Omit<ScorerContext, 'judge' | 'runScript' | 'pairwise'>,
  input: EvalCoreInput,
  modelUnderTest: ModelRef,
  signal: AbortSignal
): Promise<EvalCellResult['scores']> {
  const completeFor = (model: ModelRef): JudgeComplete => {
    // Fail closed: a judge that is the model under test grades its own output. The
    // builder refuses such a config up front; this guard covers headless callers.
    if (sameModelRef(model, modelUnderTest)) throw new Error(selfJudgingMessage(model));
    if (!input.port.has(model)) throw new Error('judge provider not configured');
    // The judge algorithm (criteria, sampling, aggregation) lives in shared
    // runJudge; we inject only transport — a retry-wrapped model call.
    return (messages, tools) =>
      completeWithRetry(
        () =>
          input.port.complete(model, messages as ChatMessageWire[], {
            ...(tools ? { tools: tools as AiToolDef[] } : {}),
            signal,
          }),
        { signal }
      );
  };
  const judge: ScorerContext['judge'] = async ({ judgeModel, input: judgeInput }) =>
    runJudge(judgeInput, completeFor(judgeModel));
  const pairwise: ScorerContext['pairwise'] = async ({
    judgeModel,
    outputA,
    outputB,
    passThreshold,
    criteria,
    swapPositions,
  }) =>
    runPairwiseJudge(
      {
        outputA,
        outputB,
        passThreshold,
        ...(criteria ? { criteria } : {}),
        ...(swapPositions !== undefined ? { swapPositions } : {}),
      },
      completeFor(judgeModel)
    );
  const full: ScorerContext = {
    ...ctx,
    judge,
    pairwise,
    ...(input.runScript ? { runScript: input.runScript } : {}),
  };
  return Promise.all(scorers.map((s) => runScorer(s, full)));
}

/** Execute a single (case × model) cell end-to-end. */
async function runCell(
  input: EvalCoreInput,
  c: DatasetCase,
  modelRef: ModelRef,
  signal: AbortSignal
): Promise<EvalCellResult> {
  const base: Omit<EvalCellResult, 'scores' | 'passed'> = {
    caseId: c.id,
    modelRef,
    output: '',
    ok: false,
    latencyMs: 0,
    cost: null,
  };
  if (!input.port.has(modelRef)) {
    return { ...base, error: 'provider config not found', scores: [], passed: false };
  }

  const startedAt = performance.now();
  let completion: CompletionResult;
  try {
    completion = await completeWithRetry(
      () =>
        input.port.complete(modelRef, buildEvalMessages(input.prompt, c), {
          ...(input.tools ? { tools: input.tools } : {}),
          signal,
        }),
      { signal }
    );
  } catch (e) {
    if (signal.aborted) throw signal.reason ?? e;
    return {
      ...base,
      error: e instanceof Error ? e.message : String(e),
      latencyMs: performance.now() - startedAt,
      scores: [],
      passed: false,
    };
  }
  const latencyMs = performance.now() - startedAt;

  if (!completion.ok) {
    return {
      ...base,
      latencyMs,
      error: completion.error?.message ?? 'model call failed',
      scores: [],
      passed: false,
    };
  }

  const cost = input.port.cost(modelRef, completion.usage);
  const usagePatch = completion.usage
    ? {
        usage: {
          promptTokens: completion.usage.promptTokens,
          completionTokens: completion.usage.completionTokens,
        },
      }
    : {};

  // http-exec target: parse a request out of the completion and execute it. The
  // executed response (status + body) becomes the scoring input; the model prose
  // is no longer what's graded.
  let scoringOutput = completion.text;
  let executed: EvalCellResult['executed'];
  if (input.target?.kind === 'http-exec') {
    if (!input.runRequest) {
      return {
        ...base,
        output: completion.text,
        latencyMs,
        cost,
        ...usagePatch,
        error: 'request executor unavailable',
        scores: [],
        passed: false,
      };
    }
    const extracted =
      input.target.protocol === 'graphql'
        ? extractGraphqlSpec(completion.text, input.target.parseFrom)
        : extractRequestSpec(completion.text, input.target.parseFrom);
    if (!extracted.ok) {
      return {
        ...base,
        output: completion.text,
        latencyMs,
        cost,
        ...usagePatch,
        error: `could not extract request: ${extracted.error}`,
        scores: [],
        passed: false,
      };
    }
    try {
      const exec = await input.runRequest(extracted.request, signal);
      scoringOutput = exec.body;
      executed = {
        status: exec.status,
        latencyMs: exec.latencyMs,
        bodyExcerpt: exec.body.slice(0, EXEC_EXCERPT_LIMIT),
        ok: exec.ok,
      };
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? e;
      return {
        ...base,
        output: completion.text,
        latencyMs,
        cost,
        ...usagePatch,
        error: `request execution failed: ${e instanceof Error ? e.message : String(e)}`,
        scores: [],
        passed: false,
      };
    }
  }

  // Individual scorers fail closed inside runScorer; this guard is the backstop
  // for an UNEXPECTED throw (e.g. a scorer dependency failing to load) so one bad
  // cell fails on its own instead of rejecting the whole worker pool.
  let scores: EvalCellResult['scores'];
  try {
    scores = await scoreCell(
      input.scorers,
      {
        output: scoringOutput,
        testCase: c,
        latencyMs,
        cost,
        toolCalls: completion.toolCalls,
        ...usagePatch,
      },
      input,
      modelRef,
      signal
    );
  } catch (e) {
    return {
      caseId: c.id,
      modelRef,
      output: scoringOutput,
      ok: true,
      latencyMs,
      cost,
      ...usagePatch,
      ...(executed ? { executed } : {}),
      error: `scoring failed: ${e instanceof Error ? e.message : String(e)}`,
      scores: [],
      passed: false,
    };
  }

  return {
    caseId: c.id,
    modelRef,
    output: scoringOutput,
    ok: true,
    latencyMs,
    cost,
    ...usagePatch,
    ...(executed ? { executed } : {}),
    scores,
    // A cell with no scorers is "not evaluated", not a pass — otherwise a
    // misconfigured eval reads as 100% green.
    passed: scores.length > 0 && scores.every((s) => s.passed),
    ...(scores.length === 0 ? { notEvaluated: true } : {}),
  };
}

/**
 * Run the full eval. Returns the final cell list; `onProgress` fires after each
 * cell. Cancellation via `signal` stops dispatching new cells (in-flight cells
 * finish). Bounded by `concurrency`.
 */
export async function runEvalCore(
  input: EvalCoreInput,
  onProgress: (p: EvalProgress) => void,
  signal: AbortSignal
): Promise<EvalCellResult[]> {
  const cells: Array<{ c: DatasetCase; modelRef: ModelRef }> = [];
  for (const c of input.dataset.cases) {
    for (const modelRef of input.models) cells.push({ c, modelRef });
  }
  const total = cells.length;
  const results: EvalCellResult[] = [];
  let completed = 0;

  await runPool(cells, input.concurrency, signal, async (cell) => {
    const result = await runCell(input, cell.c, cell.modelRef, signal);
    results.push(result);
    completed += 1;
    // No defensive copy here: `results` is only ever appended to (never
    // reassigned) until the pool finishes, so handing out the live reference
    // is safe and avoids an O(n) copy on every single cell (O(n²) overall for
    // a large dataset). Consumers only read/index into it synchronously.
    onProgress({ completed, total, cells: results, done: completed === total });
  });
  if (!signal.aborted) onProgress({ completed, total, cells: results, done: true });
  return results;
}
