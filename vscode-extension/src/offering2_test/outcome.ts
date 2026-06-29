import type { CliRequestRunResult } from './cliResult';

/**
 * Pure mapping from a CLI request result to a Test Explorer outcome — extracted
 * from the vscode wiring so it can be unit-tested without the host.
 *
 *  - `passed`  → request passed
 *  - `errored` → a transport/internal error (`errorMessage` set, e.g. DNS, TLS)
 *  - `failed`  → ran but assertions or HTTP status failed
 */
export type Outcome =
  | { kind: 'passed'; durationMs: number }
  | { kind: 'failed'; durationMs: number; message: string }
  | { kind: 'errored'; durationMs: number; message: string };

export function classifyOutcome(r: CliRequestRunResult): Outcome {
  if (r.passed) return { kind: 'passed', durationMs: r.durationMs };

  if (r.errorMessage) {
    return { kind: 'errored', durationMs: r.durationMs, message: r.errorMessage };
  }

  const failedAssertions = (r.assertions ?? []).filter((a) => !a.passed);
  const message =
    failedAssertions.length > 0
      ? failedAssertions.map((a) => `${a.name}${a.error ? `: ${a.error}` : ''}`).join('\n')
      : `Request failed with HTTP ${r.status}`;
  return { kind: 'failed', durationMs: r.durationMs, message };
}
