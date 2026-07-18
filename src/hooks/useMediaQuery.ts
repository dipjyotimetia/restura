import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a media-query boundary rather than a continuously changing
 * viewport dimension. The server snapshot keeps the renderer deterministic
 * for every shipped target.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mediaQuery = window.matchMedia(query);
      mediaQuery.addEventListener('change', onStoreChange);
      return () => mediaQuery.removeEventListener('change', onStoreChange);
    },
    [query]
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
