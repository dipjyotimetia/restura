import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { HistoryItem, Request, Response } from '@/types';

interface HistoryState {
  history: HistoryItem[];
  favorites: string[]; // IDs of favorite history items
  pageSize: number;

  // Actions
  addHistoryItem: (request: Request, response?: Response) => void;
  deleteHistoryItem: (id: string) => void;
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
  getRecentGrpcMethods: (limit?: number) => Array<{ service: string; method: string; timestamp: number }>;
}

const MAX_HISTORY_ITEMS = 100;
const DEFAULT_PAGE_SIZE = 20;

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      history: [],
      favorites: [],
      pageSize: DEFAULT_PAGE_SIZE,

      addHistoryItem: (request, response) =>
        set((state) => {
          const newItem: HistoryItem = {
            id: `history-${Date.now()}`,
            request,
            response,
            timestamp: Date.now(),
          };

          const updatedHistory = [newItem, ...state.history];

          // Keep only the latest MAX_HISTORY_ITEMS
          if (updatedHistory.length > MAX_HISTORY_ITEMS) {
            updatedHistory.splice(MAX_HISTORY_ITEMS);
          }

          return { history: updatedHistory };
        }),

      deleteHistoryItem: (id) =>
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
    }
  )
);
