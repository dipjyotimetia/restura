import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import type {
  McpNotificationDraft,
  McpNotificationEntry,
} from '@/features/mcp/lib/mcpNotifications';

/**
 * Runtime-only (never persisted) server→client MCP state, kept apart from
 * `useMcpStore` so the persisted connection profile stays small (#858, #872):
 * a bounded per-connection notifications buffer and the resource URIs the
 * user subscribed to in the live session.
 */

export const MAX_MCP_NOTIFICATIONS = 200;

const EMPTY_ENTRIES: McpNotificationEntry[] = [];
const EMPTY_URIS: string[] = [];

interface McpNotificationState {
  entries: Record<string, McpNotificationEntry[]>;
  subscriptions: Record<string, string[]>;

  /** Prepend (newest first). Progress updates for the same call replace their bar in place. */
  push: (connectionId: string, draft: McpNotificationDraft) => void;
  clear: (connectionId: string) => void;
  setSubscribed: (connectionId: string, uri: string, subscribed: boolean) => void;
  /** Drop session-scoped subscription state (disconnect / upstream close). */
  resetSubscriptions: (connectionId: string) => void;
}

export const useMcpNotificationStore = create<McpNotificationState>()((set) => ({
  entries: {},
  subscriptions: {},

  push: (connectionId, draft) =>
    set((state) => {
      const current = state.entries[connectionId] ?? EMPTY_ENTRIES;
      const entry: McpNotificationEntry = { id: uuidv4(), timestamp: Date.now(), ...draft };
      let next: McpNotificationEntry[];
      const progressKey = draft.progress?.key;
      const existing =
        progressKey !== undefined
          ? current.findIndex((e) => e.kind === 'progress' && e.progress?.key === progressKey)
          : -1;
      if (existing >= 0) {
        next = [entry, ...current.slice(0, existing), ...current.slice(existing + 1)];
      } else {
        next = [entry, ...current];
      }
      if (next.length > MAX_MCP_NOTIFICATIONS) next = next.slice(0, MAX_MCP_NOTIFICATIONS);
      return { entries: { ...state.entries, [connectionId]: next } };
    }),

  clear: (connectionId) => set((state) => ({ entries: { ...state.entries, [connectionId]: [] } })),

  setSubscribed: (connectionId, uri, subscribed) =>
    set((state) => {
      const current = state.subscriptions[connectionId] ?? EMPTY_URIS;
      const has = current.includes(uri);
      if (has === subscribed) return state;
      const next = subscribed ? [...current, uri] : current.filter((u) => u !== uri);
      return { subscriptions: { ...state.subscriptions, [connectionId]: next } };
    }),

  resetSubscriptions: (connectionId) =>
    set((state) => {
      if (!state.subscriptions[connectionId]?.length) return state;
      return { subscriptions: { ...state.subscriptions, [connectionId]: [] } };
    }),
}));

export function useMcpNotifications(connectionId: string | undefined): McpNotificationEntry[] {
  return useMcpNotificationStore((state) =>
    connectionId ? (state.entries[connectionId] ?? EMPTY_ENTRIES) : EMPTY_ENTRIES
  );
}

export function useMcpSubscribedUris(connectionId: string | undefined): string[] {
  return useMcpNotificationStore((state) =>
    connectionId ? (state.subscriptions[connectionId] ?? EMPTY_URIS) : EMPTY_URIS
  );
}
