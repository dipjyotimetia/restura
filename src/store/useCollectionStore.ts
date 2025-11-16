import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Collection, CollectionItem } from '@/types';
import { v4 as uuidv4 } from 'uuid';

interface CollectionState {
  collections: Collection[];
  activeCollectionId: string | null;

  // Actions
  addCollection: (collection: Collection) => void;
  updateCollection: (id: string, updates: Partial<Collection>) => void;
  deleteCollection: (id: string) => void;
  setActiveCollection: (id: string | null) => void;
  addItemToCollection: (collectionId: string, item: CollectionItem, parentId?: string) => void;
  updateCollectionItem: (collectionId: string, itemId: string, updates: Partial<CollectionItem>) => void;
  deleteCollectionItem: (collectionId: string, itemId: string) => void;
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

      deleteCollection: (id) =>
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

      deleteCollectionItem: (collectionId, itemId) =>
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

      getCollectionById: (id) => get().collections.find((col) => col.id === id),

      createNewCollection: (name) => ({
        id: uuidv4(),
        name,
        items: [],
      }),
    }),
    {
      name: 'collection-storage',
    }
  )
);
