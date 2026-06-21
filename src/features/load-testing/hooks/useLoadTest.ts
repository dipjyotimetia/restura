import { useCallback, useRef, useState } from 'react';
import { runLoadTest, type LoadProgress, type LoadTestOptions } from '../lib/loadTestRunner';
import type { HttpRequest } from '@/types';

/**
 * Drives an in-app load test: starts the runner, throttles progress to the UI
 * (~10 fps), and supports cancellation. Progress is null until the first
 * sample arrives.
 */
export function useLoadTest() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastEmit = useRef(0);

  const start = useCallback((request: HttpRequest, options: LoadTestOptions) => {
    if (abortRef.current) return;
    setProgress(null);
    setRunning(true);
    lastEmit.current = 0;
    const ac = new AbortController();
    abortRef.current = ac;
    void runLoadTest(
      request,
      options,
      (p) => {
        const now = performance.now();
        if (p.done || now - lastEmit.current > 100) {
          lastEmit.current = now;
          setProgress(p);
        }
      },
      ac.signal
    ).finally(() => {
      abortRef.current = null;
      setRunning(false);
    });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { running, progress, start, stop };
}
