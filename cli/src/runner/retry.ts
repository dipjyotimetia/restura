import type { ExecuteOutcome } from './executors/types.js';

export interface RetryOptions {
  /** Number of additional attempts (0 = no retry). */
  retries: number;
  /** Comma-separated list: 'network', '5xx', or specific status codes. */
  retryOn: Array<'network' | '5xx' | '4xx' | number>;
  /** Base delay in ms between attempts; exponential backoff multiplier of 2. */
  baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  retries: 0,
  retryOn: ['network', '5xx'],
  baseDelayMs: 250,
};

/**
 * Wrap an executor invocation in a retry loop. The outcome is retried only
 * if it matches one of the `retryOn` rules:
 *   - `'network'`   — transport-layer failure (status 0 or executor error)
 *   - `'5xx'`       — HTTP/gRPC mapped 5xx
 *   - `'4xx'`       — HTTP 4xx (opt-in)
 *   - `<number>`    — specific status code
 *
 * Returns the LAST attempt's outcome with `durationMs` accumulated across
 * attempts so reporters see the total time spent.
 */
export async function withRetry(
  attempt: () => Promise<ExecuteOutcome>,
  opts: RetryOptions
): Promise<ExecuteOutcome> {
  let lastOutcome: ExecuteOutcome = await attempt();
  let totalDuration = lastOutcome.durationMs;
  for (let i = 0; i < opts.retries; i++) {
    if (!shouldRetry(lastOutcome, opts.retryOn)) break;
    const delay = opts.baseDelayMs * 2 ** i;
    await sleep(delay);
    lastOutcome = await attempt();
    totalDuration += lastOutcome.durationMs;
  }
  return { ...lastOutcome, durationMs: totalDuration };
}

function shouldRetry(
  outcome: ExecuteOutcome,
  rules: RetryOptions['retryOn']
): boolean {
  for (const rule of rules) {
    if (rule === 'network' && (outcome.status === 0 || outcome.errorMessage)) return true;
    if (rule === '5xx' && outcome.status >= 500 && outcome.status < 600) return true;
    if (rule === '4xx' && outcome.status >= 400 && outcome.status < 500) return true;
    if (typeof rule === 'number' && outcome.status === rule) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a `--retry-on` value like `"network,5xx,418"` into RetryOptions['retryOn']. */
export function parseRetryOn(raw: string): RetryOptions['retryOn'] {
  const out: RetryOptions['retryOn'] = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
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
