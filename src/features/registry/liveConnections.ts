import { useEffect, useRef, useState } from 'react';
import { protocolRegistry } from './registry';

/**
 * Which of `tabIds` currently own a live (open or (re)connecting) connection,
 * as reported by each registered protocol's `connectionLifecycle.isLive`.
 * Used to confirm before closing tabs. A lifecycle that throws is treated as
 * "not live" — this is advisory UI, never a reason to block closing.
 */
export function liveTabIds(tabIds: string[]): string[] {
  if (tabIds.length === 0) return [];
  const checks = protocolRegistry
    .list()
    .map((m) => m.connectionLifecycle?.isLive)
    .filter((fn): fn is (tabId: string) => boolean => typeof fn === 'function');
  if (checks.length === 0) return [];
  return tabIds.filter((id) =>
    checks.some((isLive) => {
      try {
        return isLive(id);
      } catch {
        return false;
      }
    })
  );
}

/**
 * Reactive `liveTabIds` for UI (e.g. a "live" dot on tabs). Connection state
 * lives in per-protocol stores the caller doesn't import, so the result is
 * recomputed on every render and re-checked on a light poll; the component
 * only re-renders when the live set actually changes.
 */
export function useLiveTabIds(tabIds: string[], pollMs = 1000): string[] {
  const live = liveTabIds(tabIds);
  const key = live.join('\n');
  const keyRef = useRef(key);
  keyRef.current = key;
  const idsRef = useRef(tabIds);
  idsRef.current = tabIds;
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (liveTabIds(idsRef.current).join('\n') !== keyRef.current) setTick((n) => n + 1);
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs]);

  return live;
}
