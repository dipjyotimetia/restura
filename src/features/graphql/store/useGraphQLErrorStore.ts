import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { GraphQLErrorEntry, GraphQLErrorLocation } from '@/features/graphql/lib/graphqlErrors';

/**
 * Ephemeral (not persisted) bridge between the GraphQL response surfaces and
 * the query editor: which errors came back for which sent query (→ editor
 * markers), and "jump to this location" requests from the errors panels.
 */

export interface GraphQLErrorSnapshot {
  /** The exact query document that was sent; locations index into it. */
  query: string;
  errors: GraphQLErrorEntry[];
}

export interface GraphQLErrorFocusRequest {
  tabId: string;
  location: GraphQLErrorLocation;
  nonce: number;
}

interface GraphQLErrorState {
  byTab: Record<string, GraphQLErrorSnapshot>;
  focus: GraphQLErrorFocusRequest | null;
  /** Record the errors for a sent query; an empty list clears the tab. */
  publish: (tabId: string, query: string, errors: GraphQLErrorEntry[]) => void;
  clear: (tabId: string) => void;
  focusLocation: (tabId: string, location: GraphQLErrorLocation) => void;
  /** Mark a focus request handled (no-op if a newer one superseded it). */
  consumeFocus: (nonce: number) => void;
}

let nonce = 0;

export const useGraphQLErrorStore = create<GraphQLErrorState>()((set) => ({
  byTab: {},
  focus: null,
  publish: (tabId, query, errors) =>
    set((state) => {
      const byTab = { ...state.byTab };
      if (errors.length > 0) byTab[tabId] = { query, errors };
      else delete byTab[tabId];
      return { byTab };
    }),
  clear: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTab)) return state;
      const byTab = { ...state.byTab };
      delete byTab[tabId];
      return { byTab };
    }),
  focusLocation: (tabId, location) => set({ focus: { tabId, location, nonce: ++nonce } }),
  consumeFocus: (handled) =>
    set((state) => (state.focus?.nonce === handled ? { focus: null } : state)),
}));

/** Run `onFocus` whenever a new location-focus request targets `tabId`. */
export function useOnGraphQLErrorFocus(tabId: string | undefined, onFocus: () => void): void {
  const focus = useGraphQLErrorStore((s) => s.focus);
  const callback = useRef(onFocus);
  callback.current = onFocus;
  useEffect(() => {
    if (focus && tabId && focus.tabId === tabId) callback.current();
  }, [focus, tabId]);
}
