/**
 * Latency/throughput statistics for load testing. Shared by the in-app Load
 * Test panel and the CLI's stats reporter so both compute percentiles
 * identically.
 */

export interface LoadStats {
  count: number;
  errors: number;
  /** ms */
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  /** Requests per second over the elapsed window. */
  rps: number;
}

/**
 * Nearest-rank percentile (p in [0,100]) over latency samples. Returns 0 for an
 * empty input. Sorts a copy — the caller's array is left untouched.
 */
export function percentile(latenciesMs: number[], p: number): number {
  if (latenciesMs.length === 0) return 0;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}

export function computeLoadStats(
  latenciesMs: number[],
  totalDurationMs: number,
  errors = 0
): LoadStats {
  const count = latenciesMs.length;
  if (count === 0) {
    return { count: 0, errors, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, rps: 0 };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of latenciesMs) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const seconds = totalDurationMs / 1000;
  return {
    count,
    errors,
    min,
    max,
    mean: sum / count,
    p50: percentile(latenciesMs, 50),
    p90: percentile(latenciesMs, 90),
    p95: percentile(latenciesMs, 95),
    p99: percentile(latenciesMs, 99),
    rps: seconds > 0 ? count / seconds : 0,
  };
}
