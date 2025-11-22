import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { KeyValue } from '@/types';
import { v4 as uuidv4 } from 'uuid';

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
}

interface WebSocketState {
  connections: Record<string, WebSocketConnection>;
  activeConnectionId: string | null;

  // Filter state
  messageFilter: WebSocketMessageType | 'all';
  searchQuery: string;

  // Actions
  createConnection: (url?: string) => string;
  deleteConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;

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
  deleteHeader: (connectionId: string, headerId: string) => void;

  // Protocols
  setProtocols: (connectionId: string, protocols: string[]) => void;

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
      messageFilter: 'all',
      searchQuery: '',

      createConnection: (url = '') => {
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
        };

        set((state) => ({
          connections: { ...state.connections, [id]: connection },
          activeConnectionId: id,
        }));

        return id;
      },

      deleteConnection: (id) =>
        set((state) => {
          const { [id]: _, ...rest } = state.connections;
          return {
            connections: rest,
            activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
          };
        }),

      setActiveConnection: (id) => set({ activeConnectionId: id }),

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
            binaryData,
            timestamp: Date.now(),
          };

          let messages = [...connection.messages, newMessage];

          // Keep only the latest MAX_MESSAGES_PER_CONNECTION
          if (messages.length > MAX_MESSAGES_PER_CONNECTION) {
            messages = messages.slice(-MAX_MESSAGES_PER_CONNECTION);
          }

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

      deleteHeader: (connectionId, headerId) =>
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
      }),
    }
  )
);
