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
    }),
    {
      name: 'history-storage',
    }
  )
);
