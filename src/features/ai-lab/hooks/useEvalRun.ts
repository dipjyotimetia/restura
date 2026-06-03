import { useCallback, useRef, useState } from 'react';
import { runEval, type EvalProgress } from '../lib/evalRunner';
import { useAiLabStore } from '../store/useAiLabStore';
import { useEvalRunStore } from '../store/useEvalRunStore';
import type { EvalConfig } from '../types';

/**
 * Drives an eval run: resolves the config's prompt/dataset/providers from the
 * store, streams progress to the UI (throttled ~10 fps), persists the run +
 * cells to the eval-run store, and supports cancellation. Mirrors useLoadTest.
 */
export function useEvalRun() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<EvalProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastEmit = useRef(0);

  const start = useCallback((config: EvalConfig) => {
    if (abortRef.current) return;
    const lab = useAiLabStore.getState();
    const prompt = lab.prompts[config.promptId];
    const dataset = lab.datasets[config.datasetId];
    if (!prompt || !dataset) {
      setError('Eval is missing its prompt or dataset.');
      return;
    }
    setError(null);
    setProgress(null);
    setRunning(true);
    lastEmit.current = 0;

    const runStore = useEvalRunStore.getState();
    const runId = runStore.startRun({
      evalConfigId: config.id,
      configName: config.name,
      totalCells: dataset.cases.length * config.models.length,
    });

    const ac = new AbortController();
    abortRef.current = ac;
    let lastCount = 0;

    void runEval(
      {
        prompt,
        dataset,
        models: config.models,
        scorers: config.scorers,
        providers: lab.providers,
        concurrency: config.concurrency,
      },
      (p) => {
        // Persist newly-completed cells (progress.cells is cumulative).
        for (let i = lastCount; i < p.cells.length; i++) {
          const cell = p.cells[i];
          if (cell) useEvalRunStore.getState().addCell(runId, cell);
        }
        lastCount = p.cells.length;
        const now = performance.now();
        if (p.done || now - lastEmit.current > 100) {
          lastEmit.current = now;
          setProgress(p);
        }
      },
      ac.signal
    )
      .then(() => {
        useEvalRunStore.getState().finishRun(runId, ac.signal.aborted ? 'cancelled' : 'done');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        useEvalRunStore.getState().finishRun(runId, 'error');
      })
      .finally(() => {
        abortRef.current = null;
        setRunning(false);
      });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { running, progress, error, start, stop };
}
