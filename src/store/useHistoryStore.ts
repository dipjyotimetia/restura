import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { HistoryItem, Request, Response } from '@/types';

interface HistoryState {
  history: HistoryItem[];
  favorites: string[]; // IDs of favorite history items

  // Actions
  addHistoryItem: (request: Request, response?: Response) => void;
  deleteHistoryItem: (id: string) => void;
  clearHistory: () => void;
  toggleFavorite: (id: string) => void;
  getHistoryById: (id: string) => HistoryItem | undefined;
}

const MAX_HISTORY_ITEMS = 100;

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      history: [],
      favorites: [],

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
    }),
    {
      name: 'history-storage',
    }
  )
);
