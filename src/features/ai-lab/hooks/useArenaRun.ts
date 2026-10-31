import { create } from 'zustand';
import {
  type ArenaProgress,
  type ArenaResult,
  ArenaRunError,
  arenaRunStatus,
  modelKeyOf,
  runArena,
} from '../lib/arenaRunner';
import { modelKey } from '../lib/modelOptions';
import { adaptArenaRunReport } from '../run-engine/reportEnvelope';
import { isRunCancelledWithResult, RunEngine } from '../run-engine/runEngine';
import { useAiLabStore } from '../store/useAiLabStore';
import { useArenaStore } from '../store/useArenaStore';
import type { ArenaMatch, ModelRef } from '../types';

export interface ArenaRunConfig {
  datasetId: string;
  datasetName: string;
  models: ModelRef[];
  modelLabels: Record<string, string>;
  judgeModel: ModelRef;
  concurrency: number;
  system?: string;
  sendUnredactedToCloud?: boolean;
}

/**
 * Live arena-run state in a module-scoped store (same rationale as
 * useEvalRun): the Arena tab unmounts on switch, and hook-local state used to
 * lose the progress display and the Stop handle while the run kept going.
 */
interface ArenaLiveState {
  running: boolean;
  progress: ArenaProgress | null;
  error: string | null;
  /** The run finished but its Reports-tab copy failed to save; never blocks new runs. */
  persistenceError: string | null;
  lastRunId: string | null;
}

const useArenaLiveStore = create<ArenaLiveState>()(() => ({
  running: false,
  progress: null,
  error: null,
  persistenceError: null,
  lastRunId: null,
}));

// Module-scoped so Stop keeps working after the Arena tab remounts.
const runEngine = new RunEngine<ArenaResult>();
let activeJobId: string | null = null;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Matches judged before a stop or failure, kept instead of discarded. */
function matchesFrom(cause: unknown): ArenaMatch[] {
  if (isRunCancelledWithResult<ArenaResult>(cause)) return cause.result.matches;
  if (cause instanceof ArenaRunError) return cause.matches;
  return [];
}

async function persistReport(runId: string): Promise<void> {
  const run = useArenaStore.getState().runs[runId];
  if (!run) return;
  try {
    await useAiLabStore.getState().saveRunReport(adaptArenaRunReport(run));
  } catch (cause) {
    // The run itself is safe in the arena history; only the Reports-tab copy failed.
    useArenaLiveStore.setState({
      persistenceError: `Report persistence failed: ${errorText(cause)}`,
    });
  }
}

function start(config: ArenaRunConfig): void {
  if (activeJobId) return; // a run is already in flight
  const lab = useAiLabStore.getState();
  const dataset = lab.datasets[config.datasetId];
  if (!dataset) {
    useArenaLiveStore.setState({ error: 'Dataset not found.' });
    return;
  }
  if (config.models.length < 2) {
    useArenaLiveStore.setState({ error: 'Pick at least two models.' });
    return;
  }
  useArenaLiveStore.setState({
    error: null,
    persistenceError: null,
    progress: null,
    running: true,
  });
  lab.recordRecentModels([...config.models.map(modelKey), modelKey(config.judgeModel)]);

  const modelKeys = config.models.map(modelKeyOf);
  const runId = useArenaStore.getState().startRun({
    datasetId: config.datasetId,
    datasetName: config.datasetName,
    modelKeys,
    modelLabels: config.modelLabels,
  });
  useArenaLiveStore.setState({ lastRunId: runId });

  const execution = runEngine.start(
    'arena',
    (context) =>
      runArena(
        {
          dataset,
          models: config.models,
          judgeModel: config.judgeModel,
          providers: lab.providers,
          concurrency: config.concurrency,
          ...(config.system ? { system: config.system } : {}),
          ...(config.sendUnredactedToCloud ? { sendUnredactedToCloud: true } : {}),
        },
        (p) => {
          useArenaLiveStore.setState({ progress: p });
          if (p.phase === 'done') context.reportProgress(1);
          else if (p.total > 0) {
            // Generation and judging each take half of the bar.
            const half = p.completed / p.total / 2;
            context.reportProgress(p.phase === 'generating' ? half : 0.5 + half);
          }
        },
        context.signal
      ),
    {
      classifyResult: (result) => {
        const status = arenaRunStatus(result.matches, false);
        return status === 'done' ? 'passed' : status === 'partial' ? 'failed' : 'error';
      },
      // Keep the matches judged before Stop.
      cancellationResult: (result) => result,
    }
  );
  activeJobId = execution.jobId;

  void (async () => {
    try {
      const result = await execution.result;
      const status = arenaRunStatus(result.matches, false);
      useArenaStore.getState().finishRun(runId, result.matches, status);
      const errored = result.matches.filter((m) => m.winner === 'error');
      if (errored.length > 0) {
        useArenaLiveStore.setState({
          error:
            status === 'error'
              ? `Every match failed, so there is no ranking. ${errored[0]?.error ?? ''}`.trim()
              : `${errored.length} of ${result.matches.length} matches failed and were left out of the ratings.`,
        });
      }
    } catch (e: unknown) {
      const matches = matchesFrom(e);
      if (runEngine.get(execution.jobId)?.status === 'cancelled') {
        useArenaStore.getState().finishRun(runId, matches, 'cancelled');
      } else {
        useArenaLiveStore.setState({ error: errorText(e) });
        // Keep whatever was judged before the failure instead of discarding it.
        useArenaStore
          .getState()
          .finishRun(
            runId,
            matches,
            matches.some((m) => m.winner !== 'error') ? 'partial' : 'error'
          );
      }
    } finally {
      runEngine.release(execution.jobId);
      activeJobId = null;
      useArenaLiveStore.setState({ running: false });
    }
    await persistReport(runId);
  })();
}

function stop(): void {
  if (activeJobId) runEngine.cancel(activeJobId);
}

/**
 * Drives an Arena run on the shared RunEngine: round-robin pairwise judging →
 * Elo, cancellable, persisted to the arena history and the Reports tab.
 */
export function useArenaRun() {
  const running = useArenaLiveStore((s) => s.running);
  const progress = useArenaLiveStore((s) => s.progress);
  const error = useArenaLiveStore((s) => s.error);
  const persistenceError = useArenaLiveStore((s) => s.persistenceError);
  const lastRunId = useArenaLiveStore((s) => s.lastRunId);
  return { running, progress, error, persistenceError, lastRunId, start, stop };
}
