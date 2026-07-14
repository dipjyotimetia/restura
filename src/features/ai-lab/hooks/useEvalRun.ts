import { create } from 'zustand';
import { type EvalProgress, runEval } from '../lib/evalRunner';
import { executeExtractedRequest } from '../lib/execCell';
import { modelKey, modelLabelFor } from '../lib/modelOptions';
import { type AiLabReportEnvelope, adaptEvalRunReport } from '../run-engine/reportEnvelope';
import { RunEngine } from '../run-engine/runEngine';
import { useAiLabStore } from '../store/useAiLabStore';
import { useEvalRunStore } from '../store/useEvalRunStore';
import type { EvalCellResult, EvalConfig } from '../types';

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
  persistenceError: string | null;
  /** Id of the most recently started run (for the "View report" handoff). */
  lastRunId: string | null;
  /** Sanitized live fallback retained until the canonical repository confirms the write. */
  pendingReport: Extract<AiLabReportEnvelope, { kind: 'eval' }> | null;
}

const useEvalLiveStore = create<EvalLiveState>()(() => ({
  running: false,
  progress: null,
  error: null,
  persistenceError: null,
  lastRunId: null,
  pendingReport: null,
}));

// Module-scoped so Stop keeps working after the Evals tab remounts.
const runEngine = new RunEngine<EvalCellResult[]>();
let activeJobId: string | null = null;

function start(config: EvalConfig): void {
  if (activeJobId) return; // a run is already in flight
  if (useEvalLiveStore.getState().pendingReport) {
    useEvalLiveStore.setState({
      persistenceError: 'Retry the pending report save before starting another eval.',
    });
    return;
  }
  const lab = useAiLabStore.getState();
  const prompt = lab.prompts[config.promptId];
  const dataset = lab.datasets[config.datasetId];
  if (!prompt || !dataset) {
    useEvalLiveStore.setState({ error: 'Eval is missing its prompt or dataset.' });
    return;
  }
  useEvalLiveStore.setState({
    error: null,
    persistenceError: null,
    progress: null,
    running: true,
    pendingReport: null,
  });
  lab.recordRecentModels(config.models.map(modelKey));

  // Capture friendly labels at run start so the report keeps readable names
  // even if a provider is renamed/removed later.
  const modelLabels: Record<string, string> = {};
  for (const m of config.models) {
    modelLabels[modelKey(m)] = modelLabelFor(lab.providers, m);
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

  let lastCount = 0;
  let lastEmit = 0;
  let pendingCells: EvalCellResult[] = [];

  const flushCells = () => {
    if (pendingCells.length === 0) return;
    useEvalRunStore.getState().addCells(runId, pendingCells);
    pendingCells = [];
  };

  let reportEngineProgress: ((progress: number) => void) | null = null;
  const onProgress = (p: EvalProgress) => {
    // Accumulate newly-completed cells (progress.cells is cumulative) and
    // persist them on the same ~10 fps throttle as the UI emit — onProgress
    // fires per cell, and an unthrottled store write per cell re-rendered any
    // mounted ReportView per cell.
    if (p.cells.length > lastCount) {
      pendingCells.push(...p.cells.slice(lastCount));
      lastCount = p.cells.length;
    }
    const now = performance.now();
    if (p.done || now - lastEmit > 100) {
      lastEmit = now;
      flushCells();
      useEvalLiveStore.setState({ progress: p });
    }
    reportEngineProgress?.(p.total ? p.completed / p.total : p.done ? 1 : 0);
  };

  const persistReport = async () => {
    const completed = useEvalRunStore.getState().runs[runId];
    if (!completed) return;
    const envelope = adaptEvalRunReport(completed) as Extract<
      AiLabReportEnvelope,
      { kind: 'eval' }
    >;
    useEvalLiveStore.setState({ pendingReport: envelope });
    try {
      await useAiLabStore.getState().saveRunReport(envelope);
      useEvalLiveStore.setState({ pendingReport: null, persistenceError: null });
    } catch (cause) {
      useEvalLiveStore.setState({
        persistenceError: `Report persistence failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  };

  const execution = runEngine.start('eval', async (context) => {
    reportEngineProgress = context.reportProgress;
    const target = config.target ?? { kind: 'text' };
    return runEval(
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
      context.signal
    );
  });
  activeJobId = execution.jobId;

  void (async () => {
    try {
      await execution.result;
      flushCells(); // defensive — the done-flagged progress event normally flushed already
      useEvalRunStore.getState().finishRun(runId, 'done');
      runEngine.release(execution.jobId);
      await persistReport();
    } catch (e: unknown) {
      flushCells(); // keep cells completed before a mid-run failure
      const snapshot = runEngine.get(execution.jobId);
      if (snapshot?.status === 'cancelled') {
        useEvalRunStore.getState().finishRun(runId, 'cancelled');
      } else {
        useEvalLiveStore.setState({ error: e instanceof Error ? e.message : String(e) });
        useEvalRunStore.getState().finishRun(runId, 'error');
      }
      runEngine.release(execution.jobId);
      await persistReport();
    } finally {
      runEngine.release(execution.jobId);
      activeJobId = null;
      reportEngineProgress = null;
      useEvalLiveStore.setState({ running: false });
    }
  })();
}

function stop(): void {
  if (activeJobId) runEngine.cancel(activeJobId);
}

async function retrySave(): Promise<boolean> {
  const report = useEvalLiveStore.getState().pendingReport;
  if (!report) return false;
  try {
    await useAiLabStore.getState().saveRunReport(report);
    useEvalLiveStore.setState({ pendingReport: null, persistenceError: null });
    return true;
  } catch (cause) {
    useEvalLiveStore.setState({
      persistenceError: `Report persistence failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return false;
  }
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
  const persistenceError = useEvalLiveStore((s) => s.persistenceError);
  const lastRunId = useEvalLiveStore((s) => s.lastRunId);
  const pendingReport = useEvalLiveStore((s) => s.pendingReport);
  return {
    running,
    progress,
    error,
    persistenceError,
    lastRunId,
    pendingReport,
    start,
    stop,
    retrySave,
  };
}
