import type { EvalCellResult } from '../types';

/** Default: every scored cell must pass. */
export const DEFAULT_PASS_THRESHOLD = 1;

export interface EvalPassOutcome {
  status: 'passed' | 'failed' | 'error';
  /** Why the run is `error` (only "nothing scored" today). */
  reason?: string;
  passed: number;
  scored: number;
}

/**
 * Verdict for a finished eval run against a per-eval pass threshold (a fraction
 * of scored cells, 0–1). Errored cells count as not passed; `notEvaluated`
 * cells (no scorers) are skipped and excluded from the denominator. A run with
 * nothing scored is an `error`, never a pass. Pure so the CLI can reuse it.
 */
export function evalPassOutcome(
  cells: readonly EvalCellResult[],
  threshold: number = DEFAULT_PASS_THRESHOLD
): EvalPassOutcome {
  const scoredCells = cells.filter((cell) => !cell.notEvaluated);
  const scored = scoredCells.length;
  const passed = scoredCells.filter((cell) => cell.passed).length;
  if (scored === 0) return { status: 'error', reason: 'nothing scored', passed, scored };
  // Epsilon keeps 2/3 >= 0.6667-style thresholds from failing on float noise.
  const ok = passed / scored >= threshold - 1e-9;
  return { status: ok ? 'passed' : 'failed', passed, scored };
}
