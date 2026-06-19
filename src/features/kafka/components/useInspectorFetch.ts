import { useCallback, useEffect, useRef, useState } from 'react';

type AsyncResult = { ok: true } | { ok: false; error: string };

/**
 * Shared loading/error/refresh machinery for the Kafka inspector sub-components.
 * `load` runs on mount and whenever `resetKey` changes; it does its own success
 * handling (writing component state) and returns the discriminated result so the
 * hook can surface `error`. `load` is read through a ref so the caller need not
 * memoize it — `refresh` and `run` stay stable.
 *
 * `run` wraps any other async op (e.g. reset/delete mutations) in the same
 * busy/error handling, returning the op's result for follow-up (e.g. refresh).
 */
export function useInspectorFetch(
  resetKey: string,
  load: () => Promise<AsyncResult>
): {
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  run: <R extends AsyncResult>(action: () => Promise<R>) => Promise<R>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async <R extends AsyncResult>(action: () => Promise<R>): Promise<R> => {
    setBusy(true);
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error);
    setBusy(false);
    return result;
  }, []);

  const refresh = useCallback(async () => {
    await run(() => loadRef.current());
  }, [run]);

  useEffect(() => {
    void refresh();
  }, [resetKey, refresh]);

  return { busy, error, refresh, run };
}
