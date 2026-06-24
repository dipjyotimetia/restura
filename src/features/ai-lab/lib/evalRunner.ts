// Eval orchestrator. Models the load-test runner: a bounded-concurrency sweep
// over (case × model) cells with progress callbacks and AbortSignal support.
// Each cell: render prompt → complete → score → emit. Scorers run in the
// renderer (QuickJS sandbox + Ajv live here); only the model call crosses IPC.
import { runJudge, runPairwiseJudge, type JudgeComplete } from '@shared/protocol/ai/judge';
import type {
  AiLabProviderConfig,
  AiToolDef,
  Dataset,
  DatasetCase,
  EvalCellResult,
  EvalTarget,
  ModelRef,
  PromptTemplate,
  ScorerConfig,
} from '../types';
import { runPool } from './concurrencyPool';
import type { ExecResult } from './execCell';
import { completeLlm, specFor, type LlmChatMessage, type LlmCallSpec } from './llmClient';
import { renderTemplate } from './promptTemplate';
import { extractGraphqlSpec, extractRequestSpec } from './requestExtractor';
import { runScorer, type ScorerContext } from './scorers';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { completeWithRetry } from '@/lib/shared/completeRetry';

/** Injected executor for the `http-exec` target (real one wraps execCell). */
export type RunRequestFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<ExecResult>;

/** Excerpt cap for the stored executed-response summary. */
const EXEC_EXCERPT_LIMIT = 2000;

export interface EvalRunInput {
  prompt: PromptTemplate;
  dataset: Dataset;
  models: ModelRef[];
  scorers: ScorerConfig[];
  /** Resolve a ModelRef's providerConfigId. */
  providers: Record<string, AiLabProviderConfig>;
  concurrency: number;
  /** Tool definitions exposed to the model (enables the tool-call scorer). */
  tools?: AiToolDef[];
  /** What each cell scores. Defaults to scoring the model text. */
  target?: EvalTarget;
  /** Executor for the `http-exec` target. Required when target is http-exec. */
  runRequest?: RunRequestFn;
}

export interface EvalProgress {
  completed: number;
  total: number;
  cells: EvalCellResult[];
  done: boolean;
}

/** USD cost: Ollama is free ($0); priced cloud uses the estimate; else unknown. */
function computeCost(
  cfg: AiLabProviderConfig,
  estimatedCostUSD: number | undefined
): number | null {
  if (cfg.provider === 'ollama') return 0;
  // A priced model with no usage estimate is unknown, not free — don't coerce a
  // missing estimate to $0 (which would let a cost-threshold scorer pass).
  if (cfg.pricingKnown) return estimatedCostUSD ?? null;
  return null;
}

function buildMessages(prompt: PromptTemplate, c: DatasetCase): LlmChatMessage[] {
  const messages: LlmChatMessage[] = [];
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

/** Wrap the QuickJS ScriptExecutor as a script-scorer runner (synthetic response). */
export async function runScriptScorer(args: { code: string; output: string; latencyMs: number }) {
  const executor = new ScriptExecutor();
  const result = await executor.executeScript(args.code, {
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
      body: args.output,
      time: args.latencyMs,
      size: args.output.length,
    },
  });
  const tests = result.tests ?? [];
  const failures = tests
    .filter((t) => !t.passed)
    .map((t) => (t.error ? `${t.name}: ${t.error}` : t.name));
  failures.push(...result.errors);
  const passed = result.errors.length === 0 && tests.every((t) => t.passed) && tests.length > 0;
  return { passed, failures };
}

/** Score one completed cell against all configured scorers. */
async function scoreCell(
  scorers: ScorerConfig[],
  ctx: Omit<ScorerContext, 'judge' | 'runScript' | 'pairwise'>,
  providers: Record<string, AiLabProviderConfig>
): Promise<EvalCellResult['scores']> {
  const completeFor = (model: ModelRef): JudgeComplete => {
    const cfg = providers[model.providerConfigId];
    if (!cfg) throw new Error('judge provider not configured');
    // The judge algorithm (criteria, sampling, aggregation) lives in shared
    // runJudge; we inject only transport — a retry-wrapped completeLlm.
    return (messages, tools) =>
      completeWithRetry(() =>
        completeLlm(
          specFor(cfg, model.model, messages as LlmChatMessage[], {
            tools: tools as LlmCallSpec['tools'],
          })
        )
      );
  };
  const judge: ScorerContext['judge'] = async ({ judgeModel, input }) =>
    runJudge(input, completeFor(judgeModel));
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
  const full: ScorerContext = { ...ctx, judge, pairwise, runScript: runScriptScorer };
  return Promise.all(scorers.map((s) => runScorer(s, full)));
}

interface RunCellOptions {
  tools?: AiToolDef[];
  target?: EvalTarget;
  runRequest?: RunRequestFn;
}

/** Execute a single (case × model) cell end-to-end. */
async function runCell(
  prompt: PromptTemplate,
  c: DatasetCase,
  modelRef: ModelRef,
  scorers: ScorerConfig[],
  providers: Record<string, AiLabProviderConfig>,
  opts: RunCellOptions = {}
): Promise<EvalCellResult> {
  const cfg = providers[modelRef.providerConfigId];
  const base: Omit<EvalCellResult, 'scores' | 'passed'> = {
    caseId: c.id,
    modelRef,
    output: '',
    ok: false,
    latencyMs: 0,
    cost: null,
  };
  if (!cfg) {
    return { ...base, error: 'provider config not found', scores: [], passed: false };
  }

  const startedAt = performance.now();
  let completion;
  try {
    completion = await completeWithRetry(() =>
      completeLlm(
        specFor(
          cfg,
          modelRef.model,
          buildMessages(prompt, c),
          opts.tools ? { tools: opts.tools } : {}
        )
      )
    );
  } catch (e) {
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

  const cost = computeCost(cfg, completion.usage?.estimatedCostUSD);
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
  if (opts.target?.kind === 'http-exec') {
    if (!opts.runRequest) {
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
      opts.target.protocol === 'graphql'
        ? extractGraphqlSpec(completion.text, opts.target.parseFrom)
        : extractRequestSpec(completion.text, opts.target.parseFrom);
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
      const exec = await opts.runRequest(extracted.request);
      scoringOutput = exec.body;
      executed = {
        status: exec.status,
        latencyMs: exec.latencyMs,
        bodyExcerpt: exec.body.slice(0, EXEC_EXCERPT_LIMIT),
        ok: exec.ok,
      };
    } catch (e) {
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
      scorers,
      {
        output: scoringOutput,
        testCase: c,
        latencyMs,
        cost,
        toolCalls: completion.toolCalls,
        ...usagePatch,
      },
      providers
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
 * finish). Bounded by `concurrency` (the main process has its own hard ceiling).
 */
export async function runEval(
  input: EvalRunInput,
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
    const result = await runCell(
      input.prompt,
      cell.c,
      cell.modelRef,
      input.scorers,
      input.providers,
      {
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.target ? { target: input.target } : {}),
        ...(input.runRequest ? { runRequest: input.runRequest } : {}),
      }
    );
    results.push(result);
    completed += 1;
    onProgress({ completed, total, cells: [...results], done: completed === total });
  });
  if (!signal.aborted) onProgress({ completed, total, cells: [...results], done: true });
  return results;
}
