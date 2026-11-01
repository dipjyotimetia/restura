import { useEffect } from 'react';
import { useRequestStore } from '@/store/useRequestStore';

/**
 * While the first-run welcome screen is showing, leave it as soon as a tab is
 * opened, closed or switched from anywhere else (sidebar, command palette,
 * keyboard shortcuts) — otherwise those actions would look like they did
 * nothing, because the welcome screen hides the tab bar and workspace.
 *
 * Listens only after the request store has hydrated, so restoring persisted
 * tabs on load never counts as a user action.
 */
export function useWelcomeAutoDismiss(active: boolean, dismiss: () => void): void {
  useEffect(() => {
    if (!active) return undefined;
    let unsubscribe: (() => void) | undefined;
    const arm = () => {
      unsubscribe?.();
      unsubscribe = useRequestStore.subscribe((state, prev) => {
        if (state.activeTabId !== prev.activeTabId || state.tabs.length !== prev.tabs.length) {
          dismiss();
        }
      });
    };
    if (useRequestStore.persist.hasHydrated()) arm();
    const unsubscribeHydration = useRequestStore.persist.onFinishHydration(arm);
    return () => {
      unsubscribe?.();
      unsubscribeHydration();
    };
  }, [active, dismiss]);
}
