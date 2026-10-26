import {
  deletePassthroughBags,
  hasPassthroughBag,
  MAX_COLLECTION_TREE_DEPTH,
} from '@shared/collections/passthrough-bags';
import { clearPostmanSidecar } from '@shared/collections/postman/sidecar';
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

/** Collect the dragged item's id plus all descendant ids — the set a drop target must not fall inside. */
function collectSubtreeIds(item: CollectionItem): Set<string> {
  const ids = new Set<string>([item.id]);
  const walk = (children: CollectionItem[]) => {
    for (const c of children) {
      ids.add(c.id);
      if (c.items) walk(c.items);
    }
  };
  if (item.items) walk(item.items);
  return ids;
}

/** Remove an item by id, returning the pruned tree. */
function removeFromTree(items: CollectionItem[], itemId: string): CollectionItem[] {
  return items
    .filter((i) => i.id !== itemId)
    .map((i) => (i.items ? { ...i, items: removeFromTree(i.items, itemId) } : i));
}

/**
 * Insert `node` into the tree. `beforeId` takes precedence: the node is placed
 * before that sibling *wherever it lives* in the tree (so reordering onto a
 * folder-nested sibling lands in that folder, not the root). With only
 * `parentId`, append into that folder. With neither, append to the root.
 *
 * Callers must validate the target exists before pruning — see
 * `moveCollectionItem` — otherwise a miss here would drop the node.
 */
function insertIntoTree(
  items: CollectionItem[],
  node: CollectionItem,
  parentId: string | undefined,
  beforeId: string | undefined
): CollectionItem[] {
  if (beforeId) {
    const idx = items.findIndex((i) => i.id === beforeId);
    if (idx >= 0) {
      const next = [...items];
      next.splice(idx, 0, node);
      return next;
    }
    return items.map((i) =>
      i.items ? { ...i, items: insertIntoTree(i.items, node, parentId, beforeId) } : i
    );
  }

  if (parentId) {
    return items.map((i) => {
      if (i.id === parentId && i.type === 'folder') {
        return { ...i, items: [...(i.items ?? []), node] };
      }
      return i.items ? { ...i, items: insertIntoTree(i.items, node, parentId, beforeId) } : i;
    });
  }

  return [...items, node];
}

/**
 * Drop every import passthrough bag (`_oc`, `_postman` — see
 * `PASSTHROUGH_BAG_KEYS`) from an item. Once the item (or a descendant)
 * changes, a cached bag is stale: `_oc` must be rebuilt from the live model on
 * re-export, and a `_postman` bag would describe a request the user has since
 * edited.
 */
function stripPassthroughBags(item: CollectionItem): CollectionItem {
  if (!hasPassthroughBag(item)) return item;
  return deletePassthroughBags({ ...item });
}

// Past MAX_COLLECTION_TREE_DEPTH the bag-stripping walk leaves deeper subtrees
// untouched rather than risking a stack overflow inside a store update.

/** Structural equality for plain JSON-shaped store values (auth, variables, scripts). */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Collection fields whose edit makes the root `_postman` sidecar stale. */
const ROOT_SIDECAR_STALE_KEYS = ['auth', 'variables', 'preRequestScript', 'testScript'] as const;

/** Ancestor folder ids on the path from the root to `itemId` (excludes the item). */
function ancestorPath(
  items: CollectionItem[],
  itemId: string,
  acc: string[] = []
): string[] | null {
  for (const i of items) {
    if (i.id === itemId) return acc;
    if (i.items) {
      const found = ancestorPath(i.items, itemId, [...acc, i.id]);
      if (found) return found;
    }
  }
  return null;
}

/** Strip the passthrough bags (`_oc`, `_postman`) from every item whose id is in `ids` (recursive). */
function stripPassthroughByIds(
  items: CollectionItem[],
  ids: Set<string>,
  depth = 0
): CollectionItem[] {
  if (depth > MAX_COLLECTION_TREE_DEPTH) return items;
  return items.map((i) => {
    const withChildren = i.items
      ? { ...i, items: stripPassthroughByIds(i.items, ids, depth + 1) }
      : i;
    return ids.has(i.id) ? stripPassthroughBags(withChildren) : withChildren;
  });
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
        const migrated = migrateCollectionAuth(collection);
        validateCollection(migrated);
        set((state) => ({
          collections: [...state.collections, migrated],
        }));
      },

      updateCollection: (id, updates) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== id) return col;
            const merged = { ...col, ...updates };
            // The root Postman sidecar holds collection-scope constructs
            // (unsupported auth, shadowed events, …); once auth / variables /
            // scripts are edited it is stale. Root `_oc` is deliberately kept:
            // `internalToOC` re-checks root auth / scripts freshness against
            // the live model before taking its whole-collection shortcut.
            // Strip only on a real change: file-collection reloads pass the
            // whole collection back in with these keys present but unchanged.
            if (
              ROOT_SIDECAR_STALE_KEYS.some((k) => k in updates && !sameValue(updates[k], col[k]))
            ) {
              clearPostmanSidecar(merged);
            }
            const next = migrateCollectionAuth(merged);
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
          collections: state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            if (!parentId) {
              // Root add: the new item has no `_oc` bag, which already defeats
              // the root Strategy-1 shortcut, so re-export rebuilds and the
              // item appears.
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

            // Strip the target folder's `_oc` bag (and its ancestors') — its
            // cached child list is now stale, and the folder verbatim shortcut
            // in from-internal.ts would otherwise re-export it without the new
            // child. See the `_oc` staleness note on `updateCollectionItem`.
            const withItem = addToParent(col.items);
            const staleIds = new Set<string>(ancestorPath(withItem, item.id) ?? []);
            return { ...col, items: stripPassthroughByIds(withItem, staleIds) };
          }),
        })),

      updateCollectionItem: (collectionId, itemId, updates) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            // Strip the OpenCollection `_oc` passthrough bag from the edited
            // item and every ancestor folder on its path. The bag holds the
            // verbatim imported node; once a descendant changes, the cached
            // subtree is stale and re-export must rebuild it from the live
            // model — otherwise the edit is silently lost. The root Strategy-1
            // shortcut and the folder verbatim shortcut in from-internal.ts
            // both short-circuit on these bags, so an ancestor bag left in
            // place would still emit the pre-edit subtree.
            const updateItem = (
              items: CollectionItem[]
            ): { items: CollectionItem[]; changed: boolean } => {
              let changed = false;
              const next = items.map((i) => {
                if (i.id === itemId) {
                  // A value-identical re-save (e.g. the folder settings dialog
                  // writing back normalised values) changes nothing, so no bag
                  // on the path is stale: keep the item and its ancestors.
                  const current = i as unknown as Record<string, unknown>;
                  const supplied = updates as Record<string, unknown>;
                  if (Object.keys(supplied).every((k) => sameValue(supplied[k], current[k]))) {
                    return i;
                  }
                  changed = true;
                  return stripPassthroughBags({ ...i, ...updates });
                }
                if (i.items) {
                  const res = updateItem(i.items);
                  if (res.changed) {
                    changed = true;
                    return stripPassthroughBags({ ...i, items: res.items });
                  }
                }
                return i;
              });
              return { items: next, changed };
            };

            return { ...col, items: updateItem(col.items).items };
          }),
        })),

      removeCollectionItem: (collectionId, itemId) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            const removeItem = (items: CollectionItem[]): CollectionItem[] =>
              items
                .filter((i) => i.id !== itemId)
                .map((i) => (i.items ? { ...i, items: removeItem(i.items) } : i));

            // Strip the removed item's ancestor-folder `_oc` bags (computed
            // before removal) — those cached child lists are now stale and the
            // folder verbatim shortcut in from-internal.ts would otherwise
            // resurrect the removed item on re-export. (A root-level removal
            // where every surviving sibling keeps its bag is not fully covered
            // here — that needs a Strategy-1 staleness change; tracked
            // separately.)
            const staleIds = new Set<string>(ancestorPath(col.items, itemId) ?? []);
            return { ...col, items: stripPassthroughByIds(removeItem(col.items), staleIds) };
          }),
        })),

      moveCollectionItem: (collectionId, itemId, target) =>
        set((state) => ({
          collections: state.collections.map((col) => {
            if (col.id !== collectionId) return col;

            const node = findItem(col.items, itemId);
            if (!node) return col;

            const subtreeIds = collectSubtreeIds(node);

            // Validate the target BEFORE pruning — an invalid target would
            // otherwise remove the node and fail to reinsert it (data loss).
            if (target.parentId) {
              const parent = findItem(col.items, target.parentId);
              // No-op if the target isn't a real folder, it's the moved node
              // itself / one of its descendants (cycle), or it's already the
              // item's current direct parent (would silently reorder to bottom).
              if (parent?.type !== 'folder' || subtreeIds.has(target.parentId)) return col;
              const currentParentId = (ancestorPath(col.items, itemId) ?? []).at(-1);
              if (target.parentId === currentParentId && !target.beforeId) return col;
            }
            if (target.beforeId) {
              // No-op if dropping before itself, before one of its own
              // descendants, or before a sibling that no longer exists.
              if (
                target.beforeId === itemId ||
                subtreeIds.has(target.beforeId) ||
                !findItem(col.items, target.beforeId)
              ) {
                return col;
              }
            }

            // A move restructures the tree, so every cached `_oc` bag for the
            // source and target ancestor chains (and the collection's
            // Strategy-1 shortcut, which requires *all* items to have bags)
            // goes stale. Collect those folder ids — plus the moved item — and
            // strip their bags from the final tree so re-export rebuilds the
            // moved subtree in its new home instead of emitting the pre-move
            // layout. The moved node's own content is unchanged, but its bag is
            // dropped too so a folder-nested SSE/MCP rebuilds via the extension
            // hoist path rather than surfacing as an invalid folder item.
            const sourceAncestors = ancestorPath(col.items, itemId) ?? [];
            const pruned = removeFromTree(col.items, itemId);
            const inserted = insertIntoTree(pruned, node, target.parentId, target.beforeId);
            // Derive target ancestors from the *post-move* tree so parentId,
            // beforeId (which can land the item in another folder with
            // parentId undefined), and root drops all resolve uniformly.
            const targetAncestors = ancestorPath(inserted, itemId) ?? [];
            const staleIds = new Set<string>([itemId, ...sourceAncestors, ...targetAncestors]);
            return { ...col, items: stripPassthroughByIds(inserted, staleIds) };
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
            return changed ? { ...col, variables: next } : col;
          }),
        })),
    }),
    {
      name: 'collection-storage',
      version: 3, // v3: SecretValue widening (ADR-0007)
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
