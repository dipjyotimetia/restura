// Bounded retry/backoff for AI Lab model calls. A single network blip or a
// provider 429/5xx mid-eval would otherwise fail a cell and read as a false
// regression — fatal for CI gating. We retry only TRANSIENT failures (network /
// timeout / rate-limit / 5xx), never validation, SSRF, or auth errors.
//
// `completeLlm` has two failure shapes: it THROWS on an IPC-envelope failure,
// and RETURNS a `CompletionResult` with `ok:false` on a provider error. This
// helper handles both.
import type { CompletionResult } from '@shared/protocol/ai/types';

export interface RetryOpts {
  /** Extra attempts after the first. Default 2 (3 calls total). */
  retries?: number;
  /** Base backoff in ms; doubles each attempt. Default 300. */
  baseMs?: number;
  signal?: AbortSignal;
}

const TRANSIENT_MESSAGE =
  /\b(429|5\d\d)\b|network|timeout|fetch failed|ECONN|socket hang|rate.?limit|overloaded|temporarily|unavailable/i;

function isTransientMessage(msg: string): boolean {
  return TRANSIENT_MESSAGE.test(msg);
}

/** A returned (non-thrown) completion that is worth retrying. */
function isTransientCompletion(r: CompletionResult): boolean {
  if (r.ok) return false;
  return r.error?.code === 'network' || isTransientMessage(r.error?.message ?? '');
}

function isTransientThrow(e: unknown): boolean {
  return isTransientMessage(e instanceof Error ? e.message : String(e));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation cancelled', 'AbortError');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(abortReason(signal!));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * Run a completion call with transient-only retry + exponential backoff. Returns
 * the last completion (even an `ok:false` one once retries are exhausted) or
 * rethrows the last non-transient / exhausted error.
 */
export async function completeWithRetry(
  call: () => Promise<CompletionResult>,
  opts: RetryOpts = {}
): Promise<CompletionResult> {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 300;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    try {
      const result = await call();
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      if (result.ok || attempt >= retries || !isTransientCompletion(result)) return result;
    } catch (e) {
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      if (attempt >= retries || !isTransientThrow(e)) throw e;
    }
    if (baseMs > 0) await delay(baseMs * 2 ** attempt, opts.signal);
  }
}
