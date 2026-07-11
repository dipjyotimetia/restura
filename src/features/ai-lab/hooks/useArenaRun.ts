import { create } from 'zustand';
import { runArena, modelKeyOf, type ArenaProgress } from '../lib/arenaRunner';
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
        },
        (p) => useArenaLiveStore.setState({ progress: p }),
        ac.signal
      );
      useArenaStore
        .getState()
        .finishRun(runId, result.matches, ac.signal.aborted ? 'cancelled' : 'done');
    } catch (e: unknown) {
      useArenaLiveStore.setState({ error: e instanceof Error ? e.message : String(e) });
      useArenaStore.getState().finishRun(runId, [], 'error');
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
