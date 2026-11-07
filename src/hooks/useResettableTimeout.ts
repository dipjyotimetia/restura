import { useCallback, useEffect, useRef } from 'react';

/**
 * One pending timeout per component. Scheduling replaces the previous one, and
 * a change of any `resetOn` value (e.g. a dialog's `open`) or unmounting
 * cancels it — so a stale timer can never act on a reopened dialog or clobber
 * a newer status.
 */
export function useResettableTimeout(resetOn: readonly unknown[] = []) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const schedule = useCallback(
    (fn: () => void, ms: number) => {
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        fn();
      }, ms);
    },
    [cancel]
  );
  useEffect(() => cancel, [cancel, ...resetOn]);
  return schedule;
}
