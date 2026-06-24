import { useCallback, useRef, useState } from 'react';
import { precomputeModelOutputs, runEval, type EvalProgress } from '../lib/evalRunner';
import { executeExtractedRequest } from '../lib/execCell';
import { useAiLabStore } from '../store/useAiLabStore';
import { useEvalRunStore } from '../store/useEvalRunStore';
import type { EvalConfig, ModelRef } from '../types';

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

    const onProgress = (p: EvalProgress) => {
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
    };

    void (async () => {
      try {
        const target = config.target ?? { kind: 'text' };

        // Pairwise scorers vs a baseline MODEL need that model's outputs first.
        const baselineModels = config.scorers
          .filter(
            (s): s is Extract<typeof s, { kind: 'pairwise' }> =>
              s.kind === 'pairwise' && typeof s.baseline === 'object'
          )
          .map((s) => s.baseline as ModelRef);
        let baselineByCase: Record<string, string> | undefined;
        if (baselineModels.length > 0) {
          const m = baselineModels[0]!; // one baseline model supported per run
          baselineByCase = await precomputeModelOutputs(
            prompt,
            dataset,
            m,
            lab.providers,
            config.concurrency,
            ac.signal
          );
        }

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
            ...(baselineByCase ? { baselineByCase } : {}),
          },
          onProgress,
          ac.signal
        );
        useEvalRunStore.getState().finishRun(runId, ac.signal.aborted ? 'cancelled' : 'done');
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        useEvalRunStore.getState().finishRun(runId, 'error');
      } finally {
        abortRef.current = null;
        setRunning(false);
      }
    })();
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { running, progress, error, start, stop };
}
