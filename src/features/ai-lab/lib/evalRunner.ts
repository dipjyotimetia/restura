// Desktop eval orchestrator. The cell runner, scoring, judges and http-exec
// target live in the runtime-neutral shared core (shared/ai-lab/evalCore.ts,
// shared with `restura eval run`); this module supplies the desktop port:
// model calls over IPC to Electron main, and per-config pricing. Scorers run in
// the renderer (QuickJS sandbox + Ajv live here); only the model call crosses IPC.
import {
  type EvalModelPort,
  type EvalProgress,
  type RunRequestFn,
  runEvalCore,
} from '@shared/ai-lab/evalCore';
import { runScriptScorer } from '@shared/scripts/eval-script-scorer';
import type {
  AiLabProviderConfig,
  AiToolDef,
  Dataset,
  EvalCellResult,
  EvalTarget,
  ModelRef,
  PromptTemplate,
  ScorerConfig,
} from '../types';
import { completeLlm, specFor } from './llmClient';

export type { EvalProgress, RunRequestFn };
export { runScriptScorer };

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
  /** Per-suite override: skip the main-process secret check for cloud providers. */
  sendUnredactedToCloud?: boolean;
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

/** The desktop model port: provider configs resolved in the renderer, calls over IPC. */
export function desktopEvalPort(
  providers: Record<string, AiLabProviderConfig>,
  sendUnredactedToCloud = false
): EvalModelPort {
  return {
    has: (model) => Boolean(providers[model.providerConfigId]),
    complete(model, messages, { tools, signal }) {
      const cfg = providers[model.providerConfigId];
      if (!cfg) throw new Error('provider config not found');
      return completeLlm(
        specFor(cfg, model.model, messages, {
          ...(tools ? { tools } : {}),
          ...(sendUnredactedToCloud ? { sendUnredactedToCloud: true } : {}),
        }),
        { signal }
      );
    },
    cost(model, usage) {
      const cfg = providers[model.providerConfigId];
      return cfg ? computeCost(cfg, usage?.estimatedCostUSD) : null;
    },
  };
}

/**
 * Run the full eval. Returns the final cell list; `onProgress` fires after each
 * cell. Cancellation via `signal` stops dispatching new cells (in-flight cells
 * finish). Bounded by `concurrency` (the main process has its own hard ceiling).
 */
export function runEval(
  input: EvalRunInput,
  onProgress: (p: EvalProgress) => void,
  signal: AbortSignal
): Promise<EvalCellResult[]> {
  return runEvalCore(
    {
      prompt: input.prompt,
      dataset: input.dataset,
      models: input.models,
      scorers: input.scorers,
      concurrency: input.concurrency,
      port: desktopEvalPort(input.providers, input.sendUnredactedToCloud === true),
      runScript: runScriptScorer,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.runRequest ? { runRequest: input.runRequest } : {}),
    },
    onProgress,
    signal
  );
}
