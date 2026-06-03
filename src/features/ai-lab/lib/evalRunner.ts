// Eval orchestrator. Models the load-test runner: a bounded-concurrency sweep
// over (case × model) cells with progress callbacks and AbortSignal support.
// Each cell: render prompt → complete → score → emit. Scorers run in the
// renderer (QuickJS sandbox + Ajv live here); only the model call crosses IPC.
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import type {
  AiLabProviderConfig,
  Dataset,
  DatasetCase,
  EvalCellResult,
  ModelRef,
  PromptTemplate,
  ScorerConfig,
} from '../types';
import { completeLlm, specFor, type ChatMessage } from './llmClient';
import { renderTemplate } from './promptTemplate';
import { runScorer, type ScorerContext } from './scorers';
import { buildJudgeMessages, JUDGE_TOOL, parseJudgment } from './judgePrompt';

export interface EvalRunInput {
  prompt: PromptTemplate;
  dataset: Dataset;
  models: ModelRef[];
  scorers: ScorerConfig[];
  /** Resolve a ModelRef's providerConfigId. */
  providers: Record<string, AiLabProviderConfig>;
  concurrency: number;
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

function buildMessages(prompt: PromptTemplate, c: DatasetCase): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = renderTemplate(prompt.system, c.vars).trim();
  if (system) messages.push({ role: 'system', content: system });
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
  ctx: Omit<ScorerContext, 'judge' | 'runScript'>,
  providers: Record<string, AiLabProviderConfig>
): Promise<EvalCellResult['scores']> {
  const judge: ScorerContext['judge'] = async (a) => {
    const cfg = providers[a.judgeModel.providerConfigId];
    if (!cfg) throw new Error('judge provider not configured');
    const completion = await completeLlm(
      specFor(cfg, a.judgeModel.model, buildJudgeMessages(a), { tools: [JUDGE_TOOL] })
    );
    if (!completion.ok) throw new Error(completion.error?.message ?? 'judge call failed');
    return parseJudgment(completion, a.passThreshold);
  };
  const full: ScorerContext = { ...ctx, judge, runScript: runScriptScorer };
  return Promise.all(scorers.map((s) => runScorer(s, full)));
}

/** Execute a single (case × model) cell end-to-end. */
async function runCell(
  prompt: PromptTemplate,
  c: DatasetCase,
  modelRef: ModelRef,
  scorers: ScorerConfig[],
  providers: Record<string, AiLabProviderConfig>
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
    completion = await completeLlm(specFor(cfg, modelRef.model, buildMessages(prompt, c)));
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
  // Individual scorers fail closed inside runScorer; this guard is the backstop
  // for an UNEXPECTED throw (e.g. a scorer dependency failing to load) so one bad
  // cell fails on its own instead of rejecting the whole worker pool.
  let scores: EvalCellResult['scores'];
  try {
    scores = await scoreCell(
      scorers,
      {
        output: completion.text,
        testCase: c,
        latencyMs,
        cost,
        ...(completion.usage
          ? {
              usage: {
                promptTokens: completion.usage.promptTokens,
                completionTokens: completion.usage.completionTokens,
              },
            }
          : {}),
      },
      providers
    );
  } catch (e) {
    return {
      caseId: c.id,
      modelRef,
      output: completion.text,
      ok: true,
      latencyMs,
      cost,
      ...(completion.usage
        ? {
            usage: {
              promptTokens: completion.usage.promptTokens,
              completionTokens: completion.usage.completionTokens,
            },
          }
        : {}),
      error: `scoring failed: ${e instanceof Error ? e.message : String(e)}`,
      scores: [],
      passed: false,
    };
  }

  return {
    caseId: c.id,
    modelRef,
    output: completion.text,
    ok: true,
    latencyMs,
    cost,
    ...(completion.usage
      ? {
          usage: {
            promptTokens: completion.usage.promptTokens,
            completionTokens: completion.usage.completionTokens,
          },
        }
      : {}),
    scores,
    passed: scores.length > 0 ? scores.every((s) => s.passed) : true,
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
  let next = 0;
  let completed = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) return;
      const idx = next++;
      if (idx >= cells.length) return;
      const cell = cells[idx];
      if (!cell) return;
      const result = await runCell(
        input.prompt,
        cell.c,
        cell.modelRef,
        input.scorers,
        input.providers
      );
      results.push(result);
      completed += 1;
      onProgress({ completed, total, cells: [...results], done: completed === total });
    }
  };

  const pool = Math.max(1, Math.min(input.concurrency, total || 1));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  if (!signal.aborted) onProgress({ completed, total, cells: [...results], done: true });
  return results;
}
