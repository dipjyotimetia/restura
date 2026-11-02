import { upgradeStreamPlaceholders } from '@shared/collections/postman/parse-v3-streaming';
import {
  addItem,
  moveItem,
  removeItem,
  updateItem,
  updateRoot,
} from '@shared/collections/tree-edit';
import { materializeLegacySocketIo } from '@shared/opencollection/stream-items';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { redactMcpCollectionsForWebPersistence } from '@/lib/shared/mcpWebPersistence';
import { migrateAuthConfigToSecretRef } from '@/lib/shared/secretRef-migrations';
import { validateCollection } from '@/lib/shared/store-validators';
import type { Collection, CollectionItem } from '@/types';

/**
 * Walk a collection tree and re-wrap every request's `auth` plus the
 * collection-level `auth` (if any) through the SecretValue migration.
 * Idempotent — safe on already-migrated trees.
 */
function migrateCollectionAuth(collection: Collection): Collection {
  const migratedItems = collection.items?.map((item) => migrateItemAuth(item)) ?? [];
  const auth = collection.auth ? migrateAuthConfigToSecretRef(collection.auth) : undefined;
  return { ...collection, items: migratedItems, ...(auth ? { auth } : {}) };
}

/**
 * Pre-#1209 Postman WebSocket / Socket.IO placeholder folders → native items
 * (rebuilt from their `_postman` sidecar). Idempotent; unchanged collections
 * keep their reference.
 */
function upgradeCollectionPlaceholders(collection: Collection): Collection {
  const items = upgradeStreamPlaceholders(collection.items ?? []);
  return items === collection.items ? collection : { ...collection, items };
}

/**
 * v3 → v4 (#1209): Postman placeholder folders become native items, and
 * Socket.IO entries an older OpenCollection import kept only in the cached
 * root `_oc` (then an opaque pass-through) become native Socket.IO items —
 * the extension is now rebuilt from the live tree, so they would otherwise
 * be dropped on the next export.
 */
export function migrateCollectionToV4(collection: Collection): Collection {
  // One malformed collection must never reject the whole rehydrate: the store
  // would come back empty and the next persisted `set` would overwrite the
  // user's data. Keep it as it was (it still loads and round-trips).
  try {
    if (!collection || typeof collection !== 'object') return collection;
    return materializeLegacySocketIo(upgradeCollectionPlaceholders(collection));
  } catch (err) {
    console.warn(
      `[collections] Could not upgrade WebSocket / Socket.IO items in a collection (${
        err instanceof Error ? err.name : 'error'
      }); it was kept unchanged`
    );
    return collection;
  }
}

function migrateItemAuth(item: CollectionItem): CollectionItem {
  if (item.type === 'folder') {
    const folderAuth = item.auth ? migrateAuthConfigToSecretRef(item.auth) : undefined;
    return {
      ...item,
      items: item.items?.map((sub) => migrateItemAuth(sub)) ?? [],
      ...(folderAuth ? { auth: folderAuth } : {}),
    };
  }
  if (item.request && 'auth' in item.request) {
    const auth = migrateAuthConfigToSecretRef(item.request.auth);
    if (auth) {
      return { ...item, request: { ...item.request, auth } as typeof item.request };
    }
  }
  return item;
}

/** Find an item anywhere in a tree by id (depth-first). */
function findItem(items: CollectionItem[], itemId: string): CollectionItem | undefined {
  for (const i of items) {
    if (i.id === itemId) return i;
    if (i.items) {
      const found = findItem(i.items, itemId);
      if (found) return found;
    }
  }
  return undefined;
}

interface CollectionState {
  collections: Collection[];
  activeCollectionId: string | null;

  // Actions
  addCollection: (collection: Collection) => void;
  updateCollection: (id: string, updates: Partial<Collection>) => void;
  removeCollection: (id: string) => void;
  setActiveCollection: (id: string | null) => void;
  addItemToCollection: (collectionId: string, item: CollectionItem, parentId?: string) => void;
  updateCollectionItem: (
    collectionId: string,
    itemId: string,
    updates: Partial<CollectionItem>
  ) => void;
  updateAnyCollectionItem: (itemId: string, updates: Partial<CollectionItem>) => void;
  removeCollectionItem: (collectionId: string, itemId: string) => void;
  /**
   * Move an item within a collection tree — reparent into a folder and/or
   * reorder relative to a sibling. `parentId: undefined` targets the root.
   * `beforeId` inserts before that sibling; omit to append. No-ops on a
   * self-drop or a drop into the item's own descendant (cycle guard).
   */
  moveCollectionItem: (
    collectionId: string,
    itemId: string,
    target: { parentId?: string; beforeId?: string }
  ) => void;
  getCollectionById: (id: string) => Collection | undefined;
  /** Find the collection that contains a given item (request) id, at any depth. */
  getCollectionByItemId: (itemId: string) => Collection | undefined;
  createNewCollection: (name: string) => Collection;
  /**
   * Bulk-apply `pm.collectionVariables.set/unset` mutations captured by a
   * script run back onto the collection's `variables` list — the write-back
   * half of `pm.collectionVariables` (mirrors `useGlobalsStore.
   * applyMutations`, but against `KeyValue[]` instead of a flat map).
   * `null` removes the key; a string sets/creates it (enabled: true).
   * No-op if the collection doesn't exist.
   */
  applyCollectionVarMutations: (
    collectionId: string,
    mutations: Record<string, string | null>
  ) => void;
}

export const useCollectionStore = create<CollectionState>()(
  persist(
    (set, get) => ({
      collections: [],
      activeCollectionId: null,

      addCollection: (collection) => {
        const migrated = migrateCollectionAuth(migrateCollectionToV4(collection));
        validateCollection(migrated);
        set((state) => ({
          collections: [...state.collections, migrated],
        }));
      },

      updateCollection: (id, updates) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== id) return col;
            const next = migrateCollectionAuth(migrateCollectionToV4(updateRoot(col, updates)));
            validateCollection(next);
            return next;
          }),
        })),

      removeCollection: (id) =>
        set((state) => ({
          collections: state.collections.filter((col) => col.id !== id),
          activeCollectionId: state.activeCollectionId === id ? null : state.activeCollectionId,
        })),

      setActiveCollection: (id) => set({ activeCollectionId: id }),

      addItemToCollection: (collectionId, item, parentId) =>
        set((state) => ({
          collections: state.collections.map((col) =>
            col.id === collectionId ? addItem(col, item, parentId) : col
          ),
        })),

      updateCollectionItem: (collectionId, itemId, updates) =>
        set((state) => ({
          collections: state.collections.map((col) =>
            col.id === collectionId ? updateItem(col, itemId, updates) : col
          ),
        })),

      removeCollectionItem: (collectionId, itemId) =>
        set((state) => ({
          collections: state.collections.map((col) =>
            col.id === collectionId ? removeItem(col, itemId) : col
          ),
        })),

      moveCollectionItem: (collectionId, itemId, target) =>
        set((state) => ({
          collections: state.collections.map((col) =>
            col.id === collectionId ? moveItem(col, itemId, target) : col
          ),
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

      getCollectionByItemId: (itemId) =>
        get().collections.find((col) => findItem(col.items, itemId) !== undefined),

      createNewCollection: (name) => ({
        id: uuidv4(),
        name,
        items: [],
      }),

      applyCollectionVarMutations: (collectionId, mutations) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== collectionId) return col;
            let changed = false;
            const next = [...(col.variables ?? [])];
            for (const [key, value] of Object.entries(mutations)) {
              const idx = next.findIndex((v) => v.key === key);
              if (value === null) {
                if (idx !== -1) {
                  next.splice(idx, 1);
                  changed = true;
                }
              } else if (idx !== -1) {
                if (next[idx]!.value !== value) {
                  next[idx] = { ...next[idx]!, value };
                  changed = true;
                }
              } else {
                next.push({ id: uuidv4(), key, value, enabled: true });
                changed = true;
              }
            }
            if (!changed) return col;
            // Same staleness rule as updateCollection: a real variables change
            // makes the root `_postman` sidecar stale. Root `_oc` is kept —
            // internalToOC re-checks root variables freshness itself.
            return updateRoot(col, { variables: next });
          }),
        })),
    }),
    {
      name: 'collection-storage',
      // v3: SecretValue widening (ADR-0007); v4: WebSocket / Socket.IO
      // placeholder folders → native items (#1209).
      version: 4,
      storage: dexieStorageAdapters.collections(),
      // #896: saved MCP credentials never reach the browser's unencrypted
      // IndexedDB (desktop passes through — its store is keychain-encrypted).
      partialize: (state) => ({
        ...state,
        collections: redactMcpCollectionsForWebPersistence(state.collections),
      }),
      migrate: (persistedState, version) => {
        let state = persistedState as CollectionState | null;
        if (state && version < 3 && Array.isArray(state.collections)) {
          state = {
            ...state,
            collections: state.collections.map((c) => migrateCollectionAuth(c)),
          };
        }
        if (state && version < 4 && Array.isArray(state.collections)) {
          state = { ...state, collections: state.collections.map(migrateCollectionToV4) };
        }
        return state as CollectionState;
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
