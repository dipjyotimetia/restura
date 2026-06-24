import { useCallback, useRef, useState } from 'react';
import { runArena, modelKeyOf, type ArenaProgress } from '../lib/arenaRunner';
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

/** Drives an Arena run: round-robin pairwise judging → Elo, persisted + cancellable. */
export function useArenaRun() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ArenaProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback((config: ArenaRunConfig) => {
    if (abortRef.current) return;
    const lab = useAiLabStore.getState();
    const dataset = lab.datasets[config.datasetId];
    if (!dataset) {
      setError('Dataset not found.');
      return;
    }
    if (config.models.length < 2) {
      setError('Pick at least two models.');
      return;
    }
    setError(null);
    setProgress(null);
    setRunning(true);

    const modelKeys = config.models.map(modelKeyOf);
    const runId = useArenaStore.getState().startRun({
      datasetId: config.datasetId,
      datasetName: config.datasetName,
      modelKeys,
      modelLabels: config.modelLabels,
    });
    setLastRunId(runId);

    const ac = new AbortController();
    abortRef.current = ac;

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
          (p) => setProgress(p),
          ac.signal
        );
        useArenaStore
          .getState()
          .finishRun(runId, result.matches, ac.signal.aborted ? 'cancelled' : 'done');
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        useArenaStore.getState().finishRun(runId, [], 'error');
      } finally {
        abortRef.current = null;
        setRunning(false);
      }
    })();
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { running, progress, error, lastRunId, start, stop };
}
