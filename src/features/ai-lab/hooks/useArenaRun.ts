import { create } from 'zustand';
import {
  type ArenaProgress,
  ArenaRunError,
  arenaRunStatus,
  modelKeyOf,
  runArena,
} from '../lib/arenaRunner';
import { modelKey } from '../lib/modelOptions';
import { useAiLabStore } from '../store/useAiLabStore';
import { useArenaStore } from '../store/useArenaStore';
import type { ModelRef } from '../types';

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
  lastRunId: string | null;
}

const useArenaLiveStore = create<ArenaLiveState>()(() => ({
  running: false,
  progress: null,
  error: null,
  lastRunId: null,
}));

let abortController: AbortController | null = null;

function start(config: ArenaRunConfig): void {
  if (abortController) return; // a run is already in flight
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
  useArenaLiveStore.setState({ error: null, progress: null, running: true });
  lab.recordRecentModels([...config.models.map(modelKey), modelKey(config.judgeModel)]);

  const modelKeys = config.models.map(modelKeyOf);
  const runId = useArenaStore.getState().startRun({
    datasetId: config.datasetId,
    datasetName: config.datasetName,
    modelKeys,
    modelLabels: config.modelLabels,
  });
  useArenaLiveStore.setState({ lastRunId: runId });

  const ac = new AbortController();
  abortController = ac;

  void (async () => {
    try {
      const result = await runArena(
        {
          dataset,
          models: config.models,
          judgeModel: config.judgeModel,
          providers: lab.providers,
          concurrency: config.concurrency,
          ...(config.system ? { system: config.system } : {}),
          ...(config.sendUnredactedToCloud ? { sendUnredactedToCloud: true } : {}),
        },
        (p) => useArenaLiveStore.setState({ progress: p }),
        ac.signal
      );
      const status = arenaRunStatus(result.matches, ac.signal.aborted);
      useArenaStore.getState().finishRun(runId, result.matches, status);
      const errored = result.matches.filter((m) => m.winner === 'error');
      if (errored.length > 0 && status !== 'cancelled') {
        useArenaLiveStore.setState({
          error:
            status === 'error'
              ? `Every match failed, so there is no ranking. ${errored[0]?.error ?? ''}`.trim()
              : `${errored.length} of ${result.matches.length} matches failed and were left out of the ratings.`,
        });
      }
    } catch (e: unknown) {
      useArenaLiveStore.setState({ error: e instanceof Error ? e.message : String(e) });
      // Keep whatever was judged before the failure instead of discarding it.
      const matches = e instanceof ArenaRunError ? e.matches : [];
      useArenaStore
        .getState()
        .finishRun(runId, matches, matches.some((m) => m.winner !== 'error') ? 'partial' : 'error');
    } finally {
      abortController = null;
      useArenaLiveStore.setState({ running: false });
    }
  })();
}

function stop(): void {
  abortController?.abort();
}

/** Drives an Arena run: round-robin pairwise judging → Elo, persisted + cancellable. */
export function useArenaRun() {
  const running = useArenaLiveStore((s) => s.running);
  const progress = useArenaLiveStore((s) => s.progress);
  const error = useArenaLiveStore((s) => s.error);
  const lastRunId = useArenaLiveStore((s) => s.lastRunId);
  return { running, progress, error, lastRunId, start, stop };
}
