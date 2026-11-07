import { Loader2 } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { lazy, Suspense } from 'react';

interface LazyComponentOptions {
  /** Extra import attempts after the first failure (default 2). */
  retries?: number;
  /** Base backoff before a retry; doubles per attempt (default 400ms). */
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function importWithRetry<T>(
  importFn: () => Promise<T>,
  retries: number,
  retryDelayMs: number
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await importFn();
    } catch (error) {
      if (attempt >= retries) throw error;
      // Transient chunk fetch failures (flaky network, a deploy swapping
      // assets mid-session) often succeed on a second try.
      await sleep(retryDelayMs * 2 ** attempt);
      attempt += 1;
    }
  }
}

/**
 * `React.lazy` + `Suspense` with chunk-load resilience: the import is retried
 * with backoff, and when every attempt fails the error propagates to the
 * nearest error boundary *without* caching the rejection — React.lazy memoises
 * its promise forever, so we swap in a fresh lazy component and the boundary's
 * "Try again" re-imports instead of re-throwing the stale failure.
 */
export function lazyComponent<P extends object>(
  importFn: () => Promise<{ default: ComponentType<P> }>,
  fallback: ReactNode = null,
  { retries = 2, retryDelayMs = 400 }: LazyComponentOptions = {}
): ComponentType<P> {
  const createLazy = () =>
    lazy(() =>
      importWithRetry(importFn, retries, retryDelayMs).catch((error: unknown) => {
        Lazy = createLazy();
        throw error;
      })
    );
  let Lazy = createLazy();
  const Wrapped: ComponentType<P> = (props: P) => (
    <Suspense fallback={fallback}>
      <Lazy {...props} />
    </Suspense>
  );
  return Wrapped;
}

/**
 * Small centred spinner for lazily loaded dialogs/drawers (command palette,
 * settings) so a slow chunk shows progress instead of nothing.
 */
export function LazyDialogFallback({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
    >
      <div className="flex items-center gap-2 rounded-md border border-sp-line bg-sp-surface px-3 py-2 text-sp-12 text-sp-muted shadow-lg">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
}
