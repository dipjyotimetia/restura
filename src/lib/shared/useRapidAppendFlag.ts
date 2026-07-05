import { useRef } from 'react';

/**
 * True while a list is being appended to faster than ~1/thresholdMs — used to
 * stamp `data-stream-rapid` on streaming containers so `.sp-stream-row` entry
 * animation switches off during bursts (globals.css) instead of becoming a
 * wall of overlapping slide-ins and wasted paints.
 *
 * Render-time ref bookkeeping, no state: a burst is already re-rendering the
 * list, so this must not schedule extra renders of its own.
 */
export function useRapidAppendFlag(count: number, thresholdMs = 150): boolean {
  // `at: null` until the first change — the first append has no preceding
  // event, so it must never count as rapid (with 0, a first append landing
  // within thresholdMs of page load would compare against navigation start).
  const ref = useRef<{ count: number; at: number | null; rapid: boolean }>({
    count,
    at: null,
    rapid: false,
  });
  if (count !== ref.current.count) {
    const now = performance.now();
    ref.current.rapid =
      count > ref.current.count && ref.current.at !== null && now - ref.current.at < thresholdMs;
    ref.current.at = now;
    ref.current.count = count;
  }
  return ref.current.rapid;
}
