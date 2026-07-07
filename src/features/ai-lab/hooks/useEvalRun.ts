import { create } from 'zustand';
import { runEval, type EvalProgress } from '../lib/evalRunner';
import { executeExtractedRequest } from '../lib/execCell';
import { useAiLabStore } from '../store/useAiLabStore';
import { useEvalRunStore } from '../store/useEvalRunStore';
import type { EvalConfig } from '../types';

/**
 * Live eval-run state, held in a module-scoped store (NOT component state) so
 * it survives the AI Lab's unmount-on-tab-switch: leaving the Evals tab
 * mid-run used to strand the run — progress vanished, Stop was gone (the
 * abort ref died with the hook), and "Run eval" would happily start a second
 * concurrent run. Cells still persist through useEvalRunStore as before.
 */
interface EvalLiveState {
  running: boolean;
  progress: EvalProgress | null;
  error: string | null;
  /** Id of the most recently started run (for the "View report" handoff). */
  lastRunId: string | null;
}

const useEvalLiveStore = create<EvalLiveState>()(() => ({
  running: false,
  progress: null,
  error: null,
  lastRunId: null,
}));

// Module-scoped so Stop keeps working after the Evals tab remounts.
let abortController: AbortController | null = null;

function start(config: EvalConfig): void {
  if (abortController) return; // a run is already in flight
  const lab = useAiLabStore.getState();
  const prompt = lab.prompts[config.promptId];
  const dataset = lab.datasets[config.datasetId];
  if (!prompt || !dataset) {
    useEvalLiveStore.setState({ error: 'Eval is missing its prompt or dataset.' });
    return;
  }
  useEvalLiveStore.setState({ error: null, progress: null, running: true });

  // Capture friendly labels at run start so the report keeps readable names
  // even if a provider is renamed/removed later.
  const modelLabels: Record<string, string> = {};
  for (const m of config.models) {
    const cfg = lab.providers[m.providerConfigId];
    const modelLabel = cfg?.modelDetails?.[m.model]?.label ?? m.model;
    modelLabels[`${m.providerConfigId}:${m.model}`] = cfg
      ? `${cfg.label} · ${modelLabel}`
      : m.model;
  }

  const runStore = useEvalRunStore.getState();
  const runId = runStore.startRun({
    evalConfigId: config.id,
    configName: config.name,
    totalCells: dataset.cases.length * config.models.length,
    datasetId: dataset.id,
    datasetName: dataset.name,
    modelLabels,
  });
  useEvalLiveStore.setState({ lastRunId: runId });

  const ac = new AbortController();
  abortController = ac;
  let lastCount = 0;
  let lastEmit = 0;

  const onProgress = (p: EvalProgress) => {
    // Persist newly-completed cells (progress.cells is cumulative).
    for (let i = lastCount; i < p.cells.length; i++) {
      const cell = p.cells[i];
      if (cell) useEvalRunStore.getState().addCell(runId, cell);
    }
    lastCount = p.cells.length;
    // Throttle UI updates to ~10 fps.
    const now = performance.now();
    if (p.done || now - lastEmit > 100) {
      lastEmit = now;
      useEvalLiveStore.setState({ progress: p });
    }
  };

  void (async () => {
    try {
      const target = config.target ?? { kind: 'text' };

      await runEval(
        {
          prompt,
          dataset,
          models: config.models,
          scorers: config.scorers,
          providers: lab.providers,
          concurrency: config.concurrency,
          target,
          ...(config.tools ? { tools: config.tools } : {}),
          ...(target.kind === 'http-exec' ? { runRequest: executeExtractedRequest } : {}),
        },
        onProgress,
        ac.signal
      );
      useEvalRunStore.getState().finishRun(runId, ac.signal.aborted ? 'cancelled' : 'done');
    } catch (e: unknown) {
      useEvalLiveStore.setState({ error: e instanceof Error ? e.message : String(e) });
      useEvalRunStore.getState().finishRun(runId, 'error');
    } finally {
      abortController = null;
      useEvalLiveStore.setState({ running: false });
    }
  })();
}

function stop(): void {
  abortController?.abort();
}

/**
 * Drives an eval run: resolves the config's prompt/dataset/providers from the
 * store, streams progress to the UI (throttled ~10 fps), persists the run +
 * cells to the eval-run store, and supports cancellation. Mirrors useLoadTest.
 * State lives in a module store — see EvalLiveState above.
 */
export function useEvalRun() {
  const running = useEvalLiveStore((s) => s.running);
  const progress = useEvalLiveStore((s) => s.progress);
  const error = useEvalLiveStore((s) => s.error);
  const lastRunId = useEvalLiveStore((s) => s.lastRunId);
  return { running, progress, error, lastRunId, start, stop };
}
