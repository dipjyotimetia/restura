import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Collection, CollectionItem } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { migrateLegacyLocalStorage } from '@/lib/shared/migrate-legacy-storage';

interface CollectionState {
  collections: Collection[];
  activeCollectionId: string | null;

  // Actions
  addCollection: (collection: Collection) => void;
  updateCollection: (id: string, updates: Partial<Collection>) => void;
  removeCollection: (id: string) => void;
  setActiveCollection: (id: string | null) => void;
  addItemToCollection: (collectionId: string, item: CollectionItem, parentId?: string) => void;
  updateCollectionItem: (collectionId: string, itemId: string, updates: Partial<CollectionItem>) => void;
  updateAnyCollectionItem: (itemId: string, updates: Partial<CollectionItem>) => void;
  removeCollectionItem: (collectionId: string, itemId: string) => void;
  getCollectionById: (id: string) => Collection | undefined;
  createNewCollection: (name: string) => Collection;
}

export const useCollectionStore = create<CollectionState>()(
  persist(
    (set, get) => ({
      collections: [],
      activeCollectionId: null,

      addCollection: (collection) =>
        set((state) => ({
          collections: [...state.collections, collection],
        })),

      updateCollection: (id, updates) =>
        set((state) => ({
          collections: state.collections.map((col) =>
            col.id === id ? { ...col, ...updates } : col
          ),
        })),

      removeCollection: (id) =>
        set((state) => ({
          collections: state.collections.filter((col) => col.id !== id),
          activeCollectionId: state.activeCollectionId === id ? null : state.activeCollectionId,
        })),

      setActiveCollection: (id) => set({ activeCollectionId: id }),

      addItemToCollection: (collectionId, item, parentId) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            if (!parentId) {
              return { ...col, items: [...col.items, item] };
            }

            const addToParent = (items: CollectionItem[]): CollectionItem[] =>
              items.map((i) => {
                if (i.id === parentId && i.type === 'folder') {
                  return { ...i, items: [...(i.items || []), item] };
                }
                if (i.items) {
                  return { ...i, items: addToParent(i.items) };
                }
                return i;
              });

            return { ...col, items: addToParent(col.items) };
          }),
        })),

      updateCollectionItem: (collectionId, itemId, updates) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            const updateItem = (items: CollectionItem[]): CollectionItem[] =>
              items.map((i) => {
                if (i.id === itemId) {
                  return { ...i, ...updates };
                }
                if (i.items) {
                  return { ...i, items: updateItem(i.items) };
                }
                return i;
              });

            return { ...col, items: updateItem(col.items) };
          }),
        })),

      removeCollectionItem: (collectionId, itemId) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            const removeItem = (items: CollectionItem[]): CollectionItem[] =>
              items
                .filter((i) => i.id !== itemId)
                .map((i) => ({
                  ...i,
                  items: i.items ? removeItem(i.items) : undefined,
                }));

            return { ...col, items: removeItem(col.items) };
          }),
        })),

      updateAnyCollectionItem: (itemId, updates) => {
        const col = get().collections.find((c) => {
          const search = (items: CollectionItem[]): boolean =>
            items.some((i) => i.id === itemId || (i.items ? search(i.items) : false));
          return search(c.items);
        });
        if (col) get().updateCollectionItem(col.id, itemId, updates);
      },

      getCollectionById: (id) => get().collections.find((col) => col.id === id),

      createNewCollection: (name) => ({
        id: uuidv4(),
        name,
        items: [],
      }),
    }),
    {
      name: 'collection-storage',
      version: 2, // Bumped for Dexie migration
      storage: dexieStorageAdapters.collections(),
      migrate: (persistedState, _version) => {
        // If Dexie returned no/empty data, attempt a one-shot backfill
        // from the legacy zustand/persist localStorage key. The helper
        // also removes the legacy key so we never migrate twice.
        const looksEmpty =
          !persistedState ||
          (typeof persistedState === 'object' &&
            Object.keys(persistedState as object).length === 0);
        if (looksEmpty) {
          const legacy = migrateLegacyLocalStorage<Partial<CollectionState>>(
            'collection-storage'
          );
          if (legacy) return legacy as CollectionState;
        }
        return persistedState as CollectionState;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('Collection store rehydration failed:', error);
        }
        if (state) {
          console.debug('Collection store rehydrated from Dexie successfully');
        }
      },
    }
  )
);
