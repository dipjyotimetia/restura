import { create } from 'zustand';

/**
 * Transient, non-persisted UI state shared across components that don't have a
 * parent/child relationship — e.g. the command palette triggering a dialog that
 * is owned by a deeply-nested feature component. Keep this small; persisted or
 * domain state belongs in its own store.
 */
interface UiState {
  /** Opens the HTTP code-generator dialog (owned by RequestBuilder). */
  codeGenOpen: boolean;
  setCodeGenOpen: (open: boolean) => void;
  /** Opens the load-test dialog for the active HTTP request (owned by RequestBuilder). */
  loadTestOpen: boolean;
  setLoadTestOpen: (open: boolean) => void;
  /**
   * Requests in flight, keyed by the tab that sent them — drives the response
   * panel's elapsed timer and Cancel button. Loading is per tab, so two tabs
   * can be in flight at once; send paths set their entry and clear it when done.
   */
  inFlightByTab: Readonly<Record<string, InFlightRequest>>;
  setInFlight: (inFlight: InFlightRequest) => void;
  /** Drop the tab's entry (no-op when it has none). */
  clearInFlight: (tabId: string) => void;
}

export interface InFlightRequest {
  tabId: string;
  startedAt: number;
  cancel: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  codeGenOpen: false,
  setCodeGenOpen: (open) => set({ codeGenOpen: open }),
  loadTestOpen: false,
  setLoadTestOpen: (open) => set({ loadTestOpen: open }),
  inFlightByTab: {},
  setInFlight: (inFlight) =>
    set((state) => ({ inFlightByTab: { ...state.inFlightByTab, [inFlight.tabId]: inFlight } })),
  clearInFlight: (tabId) =>
    set((state) => {
      if (!(tabId in state.inFlightByTab)) return state;
      const { [tabId]: _removed, ...rest } = state.inFlightByTab;
      return { inFlightByTab: rest };
    }),
}));
