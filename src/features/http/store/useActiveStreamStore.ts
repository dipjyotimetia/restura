import { create } from 'zustand';

/**
 * Streaming HTTP sends still being read, by tab (not persisted).
 *
 * A streamed send (SSE / NDJSON / JSON Lines) releases the page's shared
 * loading state as soon as the stream starts, so one long-lived stream never
 * blocks sending from other tabs. The stream itself keeps running here until
 * it ends, is stopped from its panel, the tab sends again, or the tab closes.
 */
interface ActiveStreamState {
  cancels: Record<string, () => void>;
  /** Track a stream for `tabId`, stopping one already running there. */
  start: (tabId: string, cancel: () => void) => void;
  /** Forget `cancel` for `tabId` once its stream has ended (only if it is still the current one). */
  end: (tabId: string, cancel: () => void) => void;
  /** Stop the tab's running stream, if any. */
  stop: (tabId: string) => void;
}

export const useActiveStreamStore = create<ActiveStreamState>()((set, get) => ({
  cancels: {},
  start: (tabId, cancel) => {
    get().stop(tabId);
    set((s) => ({ cancels: { ...s.cancels, [tabId]: cancel } }));
  },
  end: (tabId, cancel) => {
    if (get().cancels[tabId] !== cancel) return;
    set((s) => {
      const { [tabId]: _ended, ...rest } = s.cancels;
      return { cancels: rest };
    });
  },
  stop: (tabId) => {
    const cancel = get().cancels[tabId];
    if (!cancel) return;
    set((s) => {
      const { [tabId]: _stopped, ...rest } = s.cancels;
      return { cancels: rest };
    });
    cancel();
  },
}));
