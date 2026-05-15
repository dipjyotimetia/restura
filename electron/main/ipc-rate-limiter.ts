import type { IpcMainInvokeEvent } from 'electron';

/**
 * Keyed rate limiter — independent quotas per key (typically a webContents id).
 *
 * Replaces the original single-bucket limiter, which let one runaway IPC
 * channel exhaust the budget for every other channel in the app. Each key
 * now gets its own sliding window so a malicious or buggy renderer can only
 * DoS itself, not the rest of the app.
 *
 * Entries auto-evict expired timestamps on every `check()`; call
 * `dispose(key)` when a `webContents` is destroyed to drop the entire bucket
 * eagerly instead of waiting for it to be re-touched.
 */
export interface KeyedRateLimiter {
  check(key: number | string): boolean;
  dispose(key: number | string): void;
  size(): number;
}

export function createKeyedRateLimiter(maxRequests: number, windowMs: number): KeyedRateLimiter {
  const buckets = new Map<number | string, number[]>();

  function check(key: number | string): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    let timestamps = buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      buckets.set(key, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0]! <= windowStart) {
      timestamps.shift();
    }
    if (timestamps.length >= maxRequests) return false;
    timestamps.push(now);
    return true;
  }

  function dispose(key: number | string): void {
    buckets.delete(key);
  }

  function size(): number {
    return buckets.size;
  }

  return { check, dispose, size };
}

/**
 * Wraps an IPC handler so the per-`webContents` rate limit is enforced
 * before validation/handler logic runs. Throws a rate-limit error on the
 * IPC channel, which surfaces to the renderer as a rejected `invoke`.
 *
 * Usage:
 *   ipcMain.handle('http:request',
 *     rateLimited(httpRateLimiter,
 *       createValidatedHandler('http:request', schema, async (config) => …)
 *     )
 *   );
 */
export function rateLimited<TArgs extends unknown[], TResult>(
  limiter: KeyedRateLimiter,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
): (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> {
  return async (event, ...args) => {
    if (!limiter.check(event.sender.id)) {
      throw new Error('Rate limit exceeded');
    }
    return fn(event, ...args);
  };
}

// Back-compat shim for any caller still on the legacy single-bucket API.
// New code should call createKeyedRateLimiter and pass event.sender.id.
/** @deprecated use createKeyedRateLimiter and key by event.sender.id */
export function createRateLimiter(maxRequests: number, windowMs: number): () => boolean {
  const limiter = createKeyedRateLimiter(maxRequests, windowMs);
  return () => limiter.check('__legacy_global__');
}
