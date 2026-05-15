/**
 * Cap retained connection messages to a fixed window. Both WebSocket and
 * Kafka stores keep a rolling buffer; sharing this constant prevents drift
 * and lets `capMessages` do the slice + append in one allocation instead of
 * the naive `[...prev, next].slice(-N)` pattern (which copies the full array
 * twice on every message — a hot-path cost under high inbound throughput).
 */
export const MAX_MESSAGES_PER_CONNECTION = 1000;

/**
 * Append `next` to `prev`, keeping the most recent `max` entries. Always
 * returns a new array (so Zustand sees a fresh reference and notifies
 * subscribers). When the cap is reached, only one allocation happens — a
 * tail-slice of size `max - 1` followed by a single push.
 */
export function capMessages<T>(prev: readonly T[], next: T, max: number = MAX_MESSAGES_PER_CONNECTION): T[] {
  if (prev.length < max) {
    return [...prev, next];
  }
  const trimmed = prev.slice(prev.length - (max - 1));
  trimmed.push(next);
  return trimmed;
}
