import type { PersistStorage, StorageValue } from 'zustand/middleware';

/**
 * Wrap a persist storage so rapid `setItem` calls coalesce into one write.
 *
 * Some stores mutate many times in quick succession (the AI chat appends
 * RAF-batched deltas ~60×/s; an eval run appends a result per completed cell).
 * Each write re-serializes AND AES-GCM-encrypts the ENTIRE table with a
 * PBKDF2-derived key — without debouncing, an N-item burst is O(N²) write
 * volume and dozens of key derivations per second. Debouncing collapses it to a
 * trailing write `waitMs` after activity stops, with `maxWaitMs` so a long burst
 * still checkpoints, plus a flush on page hide so the final state isn't lost.
 * `getItem`/`removeItem` pass through; persistence is best-effort either way.
 */
export function debouncedStorage<T>(
  inner: PersistStorage<T>,
  waitMs: number,
  maxWaitMs: number
): PersistStorage<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAt = 0;
  let pending: { name: string; value: StorageValue<T> } | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    firstPendingAt = 0;
    const p = pending;
    pending = null;
    if (p) void inner.setItem(p.name, p.value);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  return {
    getItem: (name) => inner.getItem(name),
    removeItem: (name) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      firstPendingAt = 0;
      return inner.removeItem(name);
    },
    setItem: (name, value) => {
      pending = { name, value };
      const now = Date.now();
      if (firstPendingAt === 0) firstPendingAt = now;
      if (timer) clearTimeout(timer);
      // Shrink the delay as we approach maxWait so a continuous burst still
      // checkpoints rather than starving the trailing write indefinitely.
      const delay = Math.max(0, Math.min(waitMs, maxWaitMs - (now - firstPendingAt)));
      timer = setTimeout(flush, delay);
    },
  };
}
