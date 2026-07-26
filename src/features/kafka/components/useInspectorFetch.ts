import { useCallback, useEffect, useRef, useState } from 'react';

type AsyncResult = { ok: true } | { ok: false; error: string };
type CurrentGuard = () => boolean;

/**
 * Shared loading/error/refresh machinery for the Kafka inspector sub-components.
 * `load` runs on mount and whenever `resetKey` changes; it does its own success
 * handling (writing component state) only while its `isCurrent` guard is true,
 * and returns the discriminated result so the hook can surface `error`. `load`
 * is read through a ref so the caller need not memoize it — `refresh` and `run`
 * stay stable.
 *
 * `run` wraps any other async op (e.g. reset/delete mutations) in the same
 * busy/error handling, returning the op's result for follow-up (e.g. refresh).
 */
export function useInspectorFetch(
  resetKey: string,
  load: (isCurrent: CurrentGuard) => Promise<AsyncResult>
): {
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  run: <R extends AsyncResult>(action: (isCurrent: CurrentGuard) => Promise<R>) => Promise<R>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);
  loadRef.current = load;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const run = useCallback(
    async <R extends AsyncResult>(action: (isCurrent: CurrentGuard) => Promise<R>): Promise<R> => {
      const requestId = ++requestIdRef.current;
      const isCurrent = () => mountedRef.current && requestId === requestIdRef.current;

      if (isCurrent()) {
        setBusy(true);
        setError(null);
      }

      try {
        const result = await action(isCurrent);
        if (isCurrent() && !result.ok) setError(result.error);
        return result;
      } catch (cause) {
        if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    []
  );

  const refresh = useCallback(async () => {
    try {
      await run((isCurrent) => loadRef.current(isCurrent));
    } catch {
      // `run` has already surfaced the failure; refresh is fire-and-forget on mount
      // and from inspector controls, so do not leak an unhandled rejection.
    }
  }, [run]);

  useEffect(() => {
    void refresh();
  }, [resetKey, refresh]);

  return { busy, error, refresh, run };
}
