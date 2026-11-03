import type { ExecuteOutcome } from './types';
import { refusedOutcome } from './variable-guard';

/**
 * How an executor failure is classified for `--retry`, in one place:
 *  - a refusal (`refused: true`) is a deterministic CLI-side decision — an
 *    unreadable secret, a URL the SSRF guard rejects, a signing failure, the
 *    CLI's own response-size cap — and is never retried;
 *  - a transport failure (`transportError: true`) means no upstream response
 *    was received (connection refused/reset, DNS failure, timeout before an
 *    answer) and is what `--retry-on network` matches;
 *  - anything else is an answer (or an error that is neither) and is matched
 *    by the status rules only.
 */

/** Thrown for a deterministic refusal raised below the executor (secret resolution, token URL guard). */
export class CliRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliRefusalError';
  }
}

/** Thrown when a transport call produced no response at all; `cause` keeps the original error. */
export class TransportFailureError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'TransportFailureError';
  }
}

function inChain(
  err: unknown,
  type: typeof CliRefusalError | typeof TransportFailureError
): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof type) return true;
    current = current.cause;
  }
  return false;
}

/** The outcome for an error an executor caught: a refusal, a transport failure, or a plain error. */
export function thrownOutcome(err: unknown, durationMs: number): ExecuteOutcome {
  const errorMessage = err instanceof Error ? err.message : String(err);
  if (inChain(err, CliRefusalError)) return { ...refusedOutcome(errorMessage), durationMs };
  const outcome: ExecuteOutcome = {
    status: 0,
    passed: false,
    durationMs,
    bodyBytes: 0,
    errorMessage,
  };
  if (inChain(err, TransportFailureError)) outcome.transportError = true;
  return outcome;
}

/**
 * Classify a shared-core `ok: false` result (`executeHttpProxy`,
 * `executeGrpcProxy`). An upstream answer always comes back `ok: true`, so the
 * status of an `ok: false` result is the core's own verdict:
 * 400 = method / URL (SSRF) / redirect-policy refusal, 500 = auth signing
 * failed, 413 = the response-size cap, 502 = fetch failed, 504 = timed out,
 * 499 = cancelled by the caller.
 */
export function sharedCoreFailure(
  status: number
): Pick<ExecuteOutcome, 'refused' | 'transportError'> {
  if (status === 400 || status === 413 || status === 500) return { refused: true };
  if (status === 502 || status === 504) return { transportError: true };
  return {};
}
