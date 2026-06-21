import type { Reporter, RunResult } from './types.js';
import { computeLoadStats } from '@/lib/shared/loadStats';

/**
 * Count failures. gRPC carries its outcome in `grpcStatus.code` (0 = OK), where
 * `status` semantics differ — use that when present; otherwise treat HTTP
 * transport errors (0) and 4xx/5xx as failures.
 */
function errorCount(result: RunResult): number {
  return result.requests.filter((r) =>
    r.grpcStatus ? r.grpcStatus.code !== 0 : r.status === 0 || r.status >= 400
  ).length;
}

/**
 * Format a latency/throughput summary from a completed run. Pure (no I/O) so it
 * can be unit-tested; the reporter just prints it.
 */
export function formatLoadStatsReport(result: RunResult): string {
  const durations = result.requests.map((r) => r.durationMs);
  const stats = computeLoadStats(durations, result.durationMs, errorCount(result));
  const row = (k: string, v: string) => `  ${k.padEnd(8)} ${v}`;
  const lines = [
    '',
    `Load stats — ${result.meta.collectionName}`,
    row('requests', String(stats.count)),
    row('errors', String(stats.errors)),
    row('rps', stats.rps.toFixed(2)),
    row('min', `${stats.min.toFixed(1)} ms`),
    row('mean', `${stats.mean.toFixed(1)} ms`),
    row('p50', `${stats.p50.toFixed(1)} ms`),
    row('p90', `${stats.p90.toFixed(1)} ms`),
    row('p95', `${stats.p95.toFixed(1)} ms`),
    row('p99', `${stats.p99.toFixed(1)} ms`),
    row('max', `${stats.max.toFixed(1)} ms`),
  ];
  return lines.join('\n');
}

/** Prints latency percentiles + throughput at the end of a run. */
export class StatsReporter implements Reporter {
  onEnd(result: RunResult): void {
    console.log(formatLoadStatsReport(result));
  }
}
