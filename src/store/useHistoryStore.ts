import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { migrateAuthConfigToSecretRef } from '@/lib/shared/secretRef-migrations';
import type { HistoryItem, Request, Response } from '@/types';
import { useSettingsStore } from './useSettingsStore';

interface HistoryState {
  history: HistoryItem[];
  favorites: string[]; // IDs of favorite history items
  pageSize: number;

  // Actions
  addHistoryItem: (request: Request, response?: Response, resolvedUrl?: string) => void;
  removeHistoryItem: (id: string) => void;
  clearHistory: () => void;
  toggleFavorite: (id: string) => void;
  getHistoryById: (id: string) => HistoryItem | undefined;
  setPageSize: (size: number) => void;

  // Computed
  getTotalPages: () => number;
  getPage: (page: number) => HistoryItem[];

  // Type-specific selectors
  getHttpHistory: () => HistoryItem[];
  getGrpcHistory: () => HistoryItem[];
  getRecentGrpcMethods: (
    limit?: number
  ) => Array<{ service: string; method: string; timestamp: number }>;
}

// Fallback cap for when settings have no value (e.g. pre-migration persisted
// state). Live cap is read from useSettingsStore.settings.maxHistoryItems.
const DEFAULT_MAX_HISTORY_ITEMS = 100;
const DEFAULT_PAGE_SIZE = 20;

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      history: [],
      favorites: [],
      pageSize: DEFAULT_PAGE_SIZE,

      addHistoryItem: (request, response, resolvedUrl) =>
        set((state) => {
          // Honour user preferences. Cross-store read is intentional — this
          // action is invoked imperatively from request executors, not from
          // React render code, so there is no subscription concern.
          const { settings } = useSettingsStore.getState();
          if (settings.autoSaveHistory === false) {
            return state;
          }
          const cap = Math.max(1, settings.maxHistoryItems ?? DEFAULT_MAX_HISTORY_ITEMS);

          const newItem: HistoryItem = {
            id: `history-${Date.now()}`,
            request,
            ...(response !== undefined && { response }),
            ...(resolvedUrl !== undefined && { resolvedUrl }),
            timestamp: Date.now(),
          };

          return {
            history: [newItem, ...state.history].slice(0, cap),
          };
        }),

      removeHistoryItem: (id) =>
        set((state) => ({
          history: state.history.filter((item) => item.id !== id),
          favorites: state.favorites.filter((favId) => favId !== id),
        })),

      clearHistory: () => set({ history: [], favorites: [] }),

      toggleFavorite: (id) =>
        set((state) => {
          const isFavorite = state.favorites.includes(id);
          return {
            favorites: isFavorite
              ? state.favorites.filter((favId) => favId !== id)
              : [...state.favorites, id],
          };
        }),

      getHistoryById: (id) => get().history.find((item) => item.id === id),

      setPageSize: (size) => set({ pageSize: size }),

      getTotalPages: () => {
        const { history, pageSize } = get();
        return Math.ceil(history.length / pageSize);
      },

      getPage: (page) => {
        const { history, pageSize } = get();
        return history.slice(page * pageSize, (page + 1) * pageSize);
      },

      getHttpHistory: () => {
        return get().history.filter((item) => item.request.type === 'http');
      },

      getGrpcHistory: () => {
        return get().history.filter((item) => item.request.type === 'grpc');
      },

      getRecentGrpcMethods: (limit = 10) => {
        const grpcHistory = get().history.filter((item) => item.request.type === 'grpc');

        // Create a map to deduplicate by service+method
        const methodMap = new Map<string, { service: string; method: string; timestamp: number }>();

        for (const item of grpcHistory) {
          if (item.request.type === 'grpc') {
            const key = `${item.request.service}/${item.request.method}`;
            if (!methodMap.has(key)) {
              methodMap.set(key, {
                service: item.request.service,
                method: item.request.method,
                timestamp: item.timestamp,
              });
            }
          }
        }

        // Convert to array and sort by timestamp
        return Array.from(methodMap.values())
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit);
      },
    }),
    {
      name: 'history-storage',
      version: 3, // v3: SecretValue widening (ADR-0007)
      storage: dexieStorageAdapters.history(),
      migrate: (persistedState, version) => {
        let state = persistedState as HistoryState | null;
        if (state && version < 3 && Array.isArray(state.history)) {
          state = {
            ...state,
            history: state.history.map((entry) => {
              const request = (entry as { request?: { auth?: unknown } }).request;
              if (!request || !('auth' in request)) return entry;
              const auth = migrateAuthConfigToSecretRef(request.auth);
              if (!auth) return entry;
              return { ...entry, request: { ...request, auth } } as HistoryItem;
            }),
          };
        }
        return state as HistoryState;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('History store rehydration failed:', error);
        }
        if (state) {
          console.debug('History store rehydrated from Dexie successfully');
        }
      },
      partialize: (state) => ({
        history: state.history,
        favorites: state.favorites,
        pageSize: state.pageSize,
      }),
    }
  )
);
