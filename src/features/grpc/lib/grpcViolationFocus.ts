import { useEffect, useState } from 'react';
import { create } from 'zustand';

/**
 * Click-to-jump handoff from the gRPC response panel's field-violation list to
 * the request editor (#941). Session-only (not persisted). The response panel
 * posts a request; the request builder switches to its Message tab and the
 * message editor reveals + selects the violation once its Monaco model is
 * ready, then consumes the request.
 */
export interface ViolationFocusRequest {
  /** Request-tab id whose editor should jump. */
  tabId: string;
  /** Index into `fieldViolationsOf(response.statusDetails)`. */
  index: number;
  /** Distinguishes repeat clicks on the same row. */
  nonce: number;
}

interface ViolationFocusState {
  pending: ViolationFocusRequest | null;
  focus: (tabId: string, index: number) => void;
  consume: (nonce: number) => void;
}

let nextNonce = 1;

export const useGrpcViolationFocus = create<ViolationFocusState>((set) => ({
  pending: null,
  focus: (tabId, index) => set({ pending: { tabId, index, nonce: nextNonce++ } }),
  consume: (nonce) => set((s) => (s.pending?.nonce === nonce ? { pending: null } : s)),
}));

/**
 * `useState` for the request builder's sub-tab that also switches to
 * `messageTab` whenever a violation jump targets this request tab.
 */
export function useSubTabWithViolationJump<T extends string>(
  messageTab: T,
  tabId: string | undefined
): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(messageTab);
  const pending = useGrpcViolationFocus((s) => s.pending);
  useEffect(() => {
    if (pending && pending.tabId === tabId) setTab(messageTab);
  }, [pending, tabId, messageTab]);
  return [tab, setTab];
}
