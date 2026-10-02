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
   * The request currently in flight, if any — drives the response panel's
   * elapsed timer and Cancel button. Loading is global (one send at a time),
   * so a single slot suffices; send paths set it and clear it when done.
   */
  inFlight: InFlightRequest | null;
  setInFlight: (inFlight: InFlightRequest | null) => void;
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
  inFlight: null,
  setInFlight: (inFlight) => set({ inFlight }),
}));
