import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { KeyValue } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { useConsoleStore } from '@/store/useConsoleStore';
import { websocketManager } from '@/features/websocket/lib/websocketManager';

export type WebSocketMessageType = 'sent' | 'received' | 'system';
export type WebSocketDataType = 'text' | 'binary';

export interface WebSocketMessage {
  id: string;
  type: WebSocketMessageType;
  dataType: WebSocketDataType;
  content: string;
  binaryData?: ArrayBuffer;
  timestamp: number;
}

export interface WebSocketConnection {
  id: string;
  url: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  messages: WebSocketMessage[];
  headers: KeyValue[];
  protocols: string[];
  autoReconnect: boolean;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  createdAt: number;
  lastConnectedAt?: number;
  heartbeatInterval: number; // ms, 0 = disabled
  heartbeatMessage: string;
}

interface WebSocketState {
  connections: Record<string, WebSocketConnection>;
  activeConnectionId: string | null;
  /**
   * Workspace-tab → connection mapping. Keeps each WS tab's connection
   * independent so switching tabs doesn't swap the live connection.
   */
  connectionByTabId: Record<string, string>;

  // Filter state
  messageFilter: WebSocketMessageType | 'all';
  searchQuery: string;

  // Actions
  createConnection: (url?: string) => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  /**
   * Idempotently returns the connection id bound to `tabId`, creating one if
   * the tab has none yet. Also flips `activeConnectionId` to point at it so
   * legacy callers still see the right connection.
   */
  ensureConnectionForTab: (tabId: string, url?: string) => string;
  /** Disconnects and removes the connection associated with `tabId`, if any. */
  cleanupConnectionForTab: (tabId: string) => void;

  // Connection state
  updateConnectionStatus: (id: string, status: WebSocketConnection['status']) => void;
  updateConnectionUrl: (id: string, url: string) => void;
  setReconnectAttempts: (id: string, attempts: number) => void;
  setAutoReconnect: (id: string, enabled: boolean) => void;
  setLastConnectedAt: (id: string, timestamp: number) => void;

  // Messages
  addMessage: (connectionId: string, type: WebSocketMessageType, content: string, dataType?: WebSocketDataType, binaryData?: ArrayBuffer) => void;
  clearMessages: (connectionId: string) => void;

  // Headers
  addHeader: (connectionId: string) => void;
  updateHeader: (connectionId: string, headerId: string, updates: Partial<KeyValue>) => void;
  removeHeader: (connectionId: string, headerId: string) => void;

  // Protocols
  setProtocols: (connectionId: string, protocols: string[]) => void;

  // Heartbeat
  setHeartbeatConfig: (connectionId: string, interval: number, message: string) => void;

  // Filtering
  setMessageFilter: (filter: WebSocketMessageType | 'all') => void;
  setSearchQuery: (query: string) => void;

  // Computed
  getActiveConnection: () => WebSocketConnection | null;
  getFilteredMessages: (connectionId: string) => WebSocketMessage[];
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY = 1000; // 1 second, will use exponential backoff
const MAX_MESSAGES_PER_CONNECTION = 1000;

export const useWebSocketStore = create<WebSocketState>()(
  persist(
    (set, get) => ({
      connections: {},
      activeConnectionId: null,
      connectionByTabId: {},
      messageFilter: 'all',
      searchQuery: '',

      createConnection: (url = ECHO_URLS.websocket) => {
        const id = uuidv4();
        const connection: WebSocketConnection = {
          id,
          url,
          status: 'disconnected',
          messages: [],
          headers: [],
          protocols: [],
          autoReconnect: true,
          reconnectAttempts: 0,
          maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
          reconnectDelay: DEFAULT_RECONNECT_DELAY,
          createdAt: Date.now(),
          heartbeatInterval: 0,
          heartbeatMessage: 'ping',
        };

        set((state) => ({
          connections: { ...state.connections, [id]: connection },
          activeConnectionId: id,
        }));

        return id;
      },

      removeConnection: (id) =>
        set((state) => {
          const { [id]: _, ...rest } = state.connections;
          const nextMap = Object.fromEntries(
            Object.entries(state.connectionByTabId).filter(([, cid]) => cid !== id)
          );
          return {
            connections: rest,
            connectionByTabId: nextMap,
            activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
          };
        }),

      setActiveConnection: (id) => set({ activeConnectionId: id }),

      ensureConnectionForTab: (tabId, url = ECHO_URLS.websocket) => {
        const existing = get().connectionByTabId[tabId];
        if (existing && get().connections[existing]) {
          if (get().activeConnectionId !== existing) set({ activeConnectionId: existing });
          return existing;
        }
        const id = get().createConnection(url);
        set((state) => ({
          connectionByTabId: { ...state.connectionByTabId, [tabId]: id },
          activeConnectionId: id,
        }));
        return id;
      },

      cleanupConnectionForTab: (tabId) => {
        const connectionId = get().connectionByTabId[tabId];
        if (!connectionId) return;
        // Best-effort disconnect; manager is a no-op if the socket is already closed.
        try {
          websocketManager.disconnect(connectionId, /* clearReconnect */ true);
        } catch {
          /* ignore */
        }
        set((state) => {
          const { [connectionId]: _drop, ...restConns } = state.connections;
          const { [tabId]: _dropTab, ...restMap } = state.connectionByTabId;
          return {
            connections: restConns,
            connectionByTabId: restMap,
            activeConnectionId:
              state.activeConnectionId === connectionId ? null : state.activeConnectionId,
          };
        });
      },

      updateConnectionStatus: (id, status) =>
        set((state) => {
          const connection = state.connections[id];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [id]: { ...connection, status },
            },
          };
        }),

      updateConnectionUrl: (id, url) =>
        set((state) => {
          const connection = state.connections[id];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [id]: { ...connection, url },
            },
          };
        }),

      setReconnectAttempts: (id, attempts) =>
        set((state) => {
          const connection = state.connections[id];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [id]: { ...connection, reconnectAttempts: attempts },
            },
          };
        }),

      setAutoReconnect: (id, enabled) =>
        set((state) => {
          const connection = state.connections[id];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [id]: { ...connection, autoReconnect: enabled },
            },
          };
        }),

      setLastConnectedAt: (id, timestamp) =>
        set((state) => {
          const connection = state.connections[id];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [id]: { ...connection, lastConnectedAt: timestamp },
            },
          };
        }),

      addMessage: (connectionId, type, content, dataType = 'text', binaryData) =>
        set((state) => {
          const connection = state.connections[connectionId];
          if (!connection) return state;

          const newMessage: WebSocketMessage = {
            id: uuidv4(),
            type,
            dataType,
            content,
            ...(binaryData !== undefined ? { binaryData } : {}),
            timestamp: Date.now(),
          };

          let messages = [...connection.messages, newMessage];

          // Keep only the latest MAX_MESSAGES_PER_CONNECTION
          if (messages.length > MAX_MESSAGES_PER_CONNECTION) {
            messages = messages.slice(-MAX_MESSAGES_PER_CONNECTION);
          }

          // Mirror to the unified console so WS frames show up alongside
          // HTTP entries in the same UI.
          useConsoleStore.getState().addFrame({
            timestamp: newMessage.timestamp,
            protocol: 'websocket',
            direction: type === 'sent' ? 'out' : type === 'received' ? 'in' : 'system',
            connectionId,
            ...(dataType === 'binary' ? { label: 'binary' } : {}),
            payload: content,
            ...(binaryData ? { bytes: binaryData.byteLength } : {}),
          });

          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...connection, messages },
            },
          };
        }),

      clearMessages: (connectionId) =>
        set((state) => {
          const connection = state.connections[connectionId];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...connection, messages: [] },
            },
          };
        }),

      addHeader: (connectionId) =>
        set((state) => {
          const connection = state.connections[connectionId];
          if (!connection) return state;

          const newHeader: KeyValue = {
            id: uuidv4(),
            key: '',
            value: '',
            enabled: true,
          };

          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...connection,
                headers: [...connection.headers, newHeader],
              },
            },
          };
        }),

      updateHeader: (connectionId, headerId, updates) =>
        set((state) => {
          const connection = state.connections[connectionId];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...connection,
                headers: connection.headers.map((h) =>
                  h.id === headerId ? { ...h, ...updates } : h
                ),
              },
            },
          };
        }),

      removeHeader: (connectionId, headerId) =>
        set((state) => {
          const connection = state.connections[connectionId];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...connection,
                headers: connection.headers.filter((h) => h.id !== headerId),
              },
            },
          };
        }),

      setProtocols: (connectionId, protocols) =>
        set((state) => {
          const connection = state.connections[connectionId];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...connection, protocols },
            },
          };
        }),

      setHeartbeatConfig: (connectionId, interval, message) =>
        set((state) => {
          const connection = state.connections[connectionId];
          if (!connection) return state;

          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...connection, heartbeatInterval: interval, heartbeatMessage: message },
            },
          };
        }),

      setMessageFilter: (filter) => set({ messageFilter: filter }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      getActiveConnection: () => {
        const { connections, activeConnectionId } = get();
        return activeConnectionId ? connections[activeConnectionId] ?? null : null;
      },

      getFilteredMessages: (connectionId) => {
        const { connections, messageFilter, searchQuery } = get();
        const connection = connections[connectionId];
        if (!connection) return [];

        let messages = connection.messages;

        // Filter by type
        if (messageFilter !== 'all') {
          messages = messages.filter((m) => m.type === messageFilter);
        }

        // Filter by search query
        if (searchQuery.trim()) {
          const query = searchQuery.toLowerCase();
          messages = messages.filter((m) =>
            m.content.toLowerCase().includes(query)
          );
        }

        return messages;
      },
    }),
    {
      name: 'websocket-storage',
      storage: dexieStorageAdapters.websocketConnections(),
      partialize: (state) => ({
        // Don't persist messages or connection status to avoid stale data
        connections: Object.fromEntries(
          Object.entries(state.connections).map(([id, conn]) => [
            id,
            {
              ...conn,
              status: 'disconnected' as const,
              messages: [], // Don't persist messages
              reconnectAttempts: 0,
            },
          ])
        ),
        activeConnectionId: state.activeConnectionId,
        connectionByTabId: state.connectionByTabId,
      }),
    }
  )
);
