import type { LoadedRequest } from '../runner/collectionLoader.js';
import { color } from '../ui/colors.js';
import type { RunResult, RequestRunResult } from './types.js';

/**
 * Shared, pure formatters for the terminal reporters. `LiveReporter` and
 * `TuiReporter` both render request lines and the run summary; keeping the
 * format here means the two can't drift.
 */

/** A request's HTTP method, falling back to the protocol name for non-HTTP. */
export function methodOf(req: LoadedRequest): string {
  return (req.request as { method?: string }).method ?? req.type.toUpperCase();
}

/** One line for a request outcome: `  ✓ GET name — 200 (12ms)` (+ an error line). */
export function formatRequestLine(r: RequestRunResult): string {
  const icon = r.errorMessage ? color.yellow('✗') : r.passed ? color.green('✓') : color.red('✗');
  const status = r.errorMessage
    ? color.yellow('ERR')
    : r.passed
      ? color.green(String(r.status))
      : color.red(String(r.status));
  const line = `  ${icon} ${methodOf(r.request)} ${r.request.request.name} — ${status} ${color.dim(`(${r.durationMs}ms)`)}`;
  return r.errorMessage ? `${line}\n    ${color.yellow(r.errorMessage)}` : line;
}

/** The run totals line: `3/4 passed (1 failed, 0 errored) in 1.20s`. */
export function formatSummaryLine(result: RunResult): string {
  const { passed, failed, errored, total } = result.summary;
  const summary = `${passed}/${total} passed`;
  return `${passed === total ? color.green(summary) : color.red(summary)} (${failed} failed, ${errored} errored) in ${(result.durationMs / 1000).toFixed(2)}s`;
}
