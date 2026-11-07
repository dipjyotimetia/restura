import { GrpcStatusCode } from '@shared/protocol/grpc-status';
import type { ExecuteOutcome } from './executors/types.js';

/**
 * The standard transient gRPC codes: the server-side analogue of a 5xx worth
 * retrying. Every other code (INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED,
 * INTERNAL, …) is an application answer and is attempted exactly once.
 */
const TRANSIENT_GRPC_CODES: ReadonlySet<number> = new Set([
  GrpcStatusCode.UNAVAILABLE,
  GrpcStatusCode.DEADLINE_EXCEEDED,
  GrpcStatusCode.RESOURCE_EXHAUSTED,
]);

export interface RetryOptions {
  /** Number of additional attempts (0 = no retry). */
  retries: number;
  /** Retry triggers: 'network', '5xx', '4xx', or specific status codes. */
  retryOn: Array<'network' | '5xx' | '4xx' | number>;
  /** Base delay in ms between attempts; exponential backoff multiplier of 2. */
  baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  retries: 0,
  retryOn: ['network', '5xx'],
  baseDelayMs: 250,
};

/** Upper bound on a server-requested `Retry-After` wait, so a hostile value cannot stall CI. */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Wrap an executor invocation in a retry loop. The outcome is retried only
 * if it matches one of the `retryOn` rules:
 *   - `'network'`   — transport failure: the executor received no upstream
 *                     response (`transportError`). An HTTP answer of any
 *                     status, an SSE 404 or a gRPC status the server sent is
 *                     not a network failure
 *   - `'5xx'`       — an HTTP 5xx (no gRPC status), or a gRPC status that is
 *                     transient: UNAVAILABLE, DEADLINE_EXCEEDED,
 *                     RESOURCE_EXHAUSTED (whatever HTTP status the executor
 *                     mapped it to)
 *   - `'4xx'`       — HTTP 4xx (opt-in)
 *   - `<number>`    — specific status code
 *
 * A refusal (`refused: true`: an unresolvable variable or secret, a blocked or
 * unsupported request, a URL the SSRF guard rejects, an auth signing failure,
 * the CLI's own response-size cap) is never retried: it is deterministic. The delay is exponential backoff,
 * except that a 429 / 503 carrying `Retry-After` waits what the server asked
 * (capped at `MAX_RETRY_AFTER_MS`).
 *
 * Returns the LAST attempt's outcome with `durationMs` accumulated across
 * attempts so reporters see the total time spent.
 */
export async function withRetry(
  attempt: () => Promise<ExecuteOutcome>,
  opts: RetryOptions,
  signal?: AbortSignal
): Promise<ExecuteOutcome> {
  let lastOutcome: ExecuteOutcome = await attempt();
  let totalDuration = lastOutcome.durationMs;
  for (let i = 0; i < opts.retries; i++) {
    // A cancelled run neither waits out the backoff nor sends another attempt.
    if (signal?.aborted || !shouldRetry(lastOutcome, opts.retryOn)) break;
    await sleep(retryDelayMs(lastOutcome, i, opts.baseDelayMs), signal);
    if (signal?.aborted) break;
    lastOutcome = await attempt();
    totalDuration += lastOutcome.durationMs;
  }
  return { ...lastOutcome, durationMs: totalDuration };
}

/**
 * The wait before retry `attempt` (0-based): `Retry-After` on a 429 / 503
 * (delta-seconds or an HTTP-date, capped; a past date means now), otherwise
 * `baseDelayMs * 2^attempt`.
 */
export function retryDelayMs(
  outcome: ExecuteOutcome,
  attempt: number,
  baseDelayMs: number,
  now: number = Date.now()
): number {
  const backoff = baseDelayMs * 2 ** attempt;
  if (outcome.status !== 429 && outcome.status !== 503) return backoff;
  const header = retryAfterHeader(outcome.responseHeaders);
  if (header === undefined) return backoff;
  let waitMs: number;
  if (/^\d+$/.test(header)) {
    waitMs = Number(header) * 1000;
  } else {
    const at = Date.parse(header);
    if (Number.isNaN(at)) return backoff;
    waitMs = Math.max(0, at - now);
  }
  return Math.min(waitMs, MAX_RETRY_AFTER_MS);
}

function retryAfterHeader(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'retry-after') return value.trim();
  }
  return undefined;
}

function isServerTransient(outcome: ExecuteOutcome): boolean {
  if (outcome.grpcStatus) return TRANSIENT_GRPC_CODES.has(outcome.grpcStatus.code);
  return outcome.status >= 500 && outcome.status < 600;
}

function shouldRetry(outcome: ExecuteOutcome, rules: RetryOptions['retryOn']): boolean {
  if (outcome.refused) return false;
  for (const rule of rules) {
    if (rule === 'network' && outcome.transportError) return true;
    if (rule === '5xx' && isServerTransient(outcome)) return true;
    if (rule === '4xx' && outcome.status >= 400 && outcome.status < 500) return true;
    if (typeof rule === 'number' && outcome.status === rule) return true;
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parse a `--retry-on` value like `"network,5xx,418"` into RetryOptions['retryOn']. */
export function parseRetryOn(raw: string): RetryOptions['retryOn'] {
  const out: RetryOptions['retryOn'] = [];
  for (const part of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (part === 'network' || part === '5xx' || part === '4xx') {
      out.push(part);
    } else {
      const n = Number(part);
      if (!Number.isFinite(n)) throw new Error(`Unknown --retry-on token: ${part}`);
      out.push(n);
    }
  }
  return out;
}
