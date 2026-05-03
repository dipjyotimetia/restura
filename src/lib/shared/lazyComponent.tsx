import type { ComponentType, ReactNode} from 'react';
import { lazy, Suspense } from 'react';

export function lazyComponent<P extends object>(
  importFn: () => Promise<{ default: ComponentType<P> }>,
  fallback: ReactNode = null
): ComponentType<P> {
  const Lazy = lazy(importFn);
  const Wrapped: ComponentType<P> = (props: P) => (
    <Suspense fallback={fallback}>
      <Lazy {...props} />
    </Suspense>
  );
  return Wrapped;
}
