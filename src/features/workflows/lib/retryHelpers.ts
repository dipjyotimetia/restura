/**
 * Generic retry-with-backoff helper used by both the legacy linear executor
 * and the new DAG executor.
 *
 * Lifted from `workflowExecutor.ts:executeWithRetry`. The old version had
 * two problems we fix while moving:
 *   1. The retry loop never observed an AbortSignal — a long-running
 *      retry sequence kept firing even after the user pressed Stop.
 *      `signal` is now checked before each attempt and during the
 *      inter-attempt sleep, and abort during sleep rejects immediately.
 *   2. The retry callback was a positional `log()` function; now an
 *      explicit `onRetry(attempt, delayMs, error)` callback so the DAG
 *      executor can emit structured state transitions instead of free-form
 *      log lines.
 */

export interface RetryPolicy {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier?: number;
}

export interface ExecuteWithRetryOptions {
  policy: RetryPolicy;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: ExecuteWithRetryOptions
): Promise<T> {
  const { policy, signal, onRetry } = options;
  const maxAttempts = Math.max(1, policy.maxAttempts);
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (error) {
      // Check abort BEFORE wrapping — DOMException may not satisfy
      // `instanceof Error` in every environment (jsdom in particular),
      // and the wrap would drop the AbortError name.
      if (isAbortError(error) || signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        const delay =
          policy.delayMs * Math.pow(policy.backoffMultiplier ?? 1, attempt - 1);
        onRetry?.(attempt, delay, lastError);
        await sleepWithAbort(delay, signal);
      }
    }
  }

  throw lastError ?? new Error('Request failed');
}

export function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  return (err as { name?: unknown }).name === 'AbortError';
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}
