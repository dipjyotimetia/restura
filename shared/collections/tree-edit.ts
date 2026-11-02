/**
 * Collection tree edits with passthrough-bag staleness owned in one place.
 *
 * Callers state WHAT changed (add / update / remove / move / root edit /
 * duplicate); this module applies the edit and decides which cached import
 * bags (`_oc`, `_postman` — see `PASSTHROUGH_BAG_KEYS`) go stale:
 *
 *  - `_oc` is the verbatim imported node; once a descendant changes the cached
 *    subtree is stale and re-export must rebuild it from the live model, so
 *    every ancestor on the edit path loses its bags.
 *  - The Postman send-guard markers (`_postman.noauth`, the unsupported auth
 *    TYPE) survive on every node whose OWN auth was not edited. Dropping them
 *    would silently re-enable auth inheritance for the whole subtree.
 *
 * Pure: inputs are never mutated (the returned collection shares untouched
 * subtrees with the input; a value-identical item update keeps the original
 * items). Runtime-neutral — no renderer imports.
 */

import type { Collection, CollectionItem } from '../types';
import {
  deletePassthroughBags,
  hasPassthroughBag,
  MAX_COLLECTION_TREE_DEPTH,
} from './passthrough-bags';
import { postmanGuardMarkers } from './postman/auth-guard';
import { attachPostmanSidecar, clearPostmanSidecar } from './postman/sidecar';

/** Structural equality for plain JSON-shaped values (auth, variables, scripts). */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Drop every bag from a (copied) node. */
function dropBags(item: CollectionItem): CollectionItem {
  if (!hasPassthroughBag(item)) return item;
  return deletePassthroughBags({ ...item });
}

/** Drop every bag except the Postman send-guard markers. */
function dropBagsKeepingGuard<T extends object>(item: T): T {
  if (!hasPassthroughBag(item)) return item;
  const markers = postmanGuardMarkers(item);
  const stripped = deletePassthroughBags({ ...item });
  return markers ? attachPostmanSidecar(stripped, markers) : stripped;
}

/** Whether `updates` changes the item's own auth (folder `auth` or `request.auth`). */
function editsOwnAuth(current: CollectionItem, updates: Partial<CollectionItem>): boolean {
  if ('auth' in updates && !sameValue(updates.auth, current.auth)) return true;
  return (
    'request' in updates &&
    !sameValue(
      (updates.request as { auth?: unknown } | undefined)?.auth,
      (current.request as { auth?: unknown } | undefined)?.auth
    )
  );
}

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

// Past MAX_COLLECTION_TREE_DEPTH the walk leaves deeper subtrees untouched
// rather than risking a stack overflow inside a store update.
function stripBagsByIds(items: CollectionItem[], ids: Set<string>, depth = 0): CollectionItem[] {
  if (depth > MAX_COLLECTION_TREE_DEPTH) return items;
  return items.map((i) => {
    const withChildren = i.items ? { ...i, items: stripBagsByIds(i.items, ids, depth + 1) } : i;
    return ids.has(i.id) ? dropBagsKeepingGuard(withChildren) : withChildren;
  });
}

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

/** The item's id plus all descendant ids — the set a drop target must not fall inside. */
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

function removeFromTree(items: CollectionItem[], itemId: string): CollectionItem[] {
  return items
    .filter((i) => i.id !== itemId)
    .map((i) => (i.items ? { ...i, items: removeFromTree(i.items, itemId) } : i));
}

/**
 * `beforeId` takes precedence: the node is placed before that sibling wherever
 * it lives (so reordering onto a folder-nested sibling lands in that folder).
 * With only `parentId`, append into that folder. With neither, append to root.
 * Callers validate the target exists before pruning, or a miss drops the node.
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
 * Add `item` at the root or into folder `parentId`. A root add needs no
 * stripping (the new item has no `_oc` bag, which already defeats the root
 * shortcut); a nested add makes the target folder's and its ancestors' cached
 * child lists stale.
 */
export function addItem(col: Collection, item: CollectionItem, parentId?: string): Collection {
  if (!parentId) return { ...col, items: [...col.items, item] };
  const addToParent = (items: CollectionItem[]): CollectionItem[] =>
    items.map((i) => {
      if (i.id === parentId && i.type === 'folder') {
        return { ...i, items: [...(i.items || []), item] };
      }
      if (i.items) return { ...i, items: addToParent(i.items) };
      return i;
    });
  const withItem = addToParent(col.items);
  const staleIds = new Set<string>(ancestorPath(withItem, item.id) ?? []);
  return { ...col, items: stripBagsByIds(withItem, staleIds) };
}

/**
 * Merge `updates` into item `itemId`. The item and every ancestor lose their
 * bags, but only the edited item's own guard markers die, and only when its
 * own auth changed. A value-identical re-save changes nothing: the original
 * items are kept so no bag on the path is dropped.
 */
export function updateItem(
  col: Collection,
  itemId: string,
  updates: Partial<CollectionItem>
): Collection {
  const walk = (items: CollectionItem[]): { items: CollectionItem[]; changed: boolean } => {
    let changed = false;
    const next = items.map((i) => {
      if (i.id === itemId) {
        const current = i as unknown as Record<string, unknown>;
        const supplied = updates as Record<string, unknown>;
        if (Object.keys(supplied).every((k) => sameValue(supplied[k], current[k]))) return i;
        changed = true;
        const merged = { ...i, ...updates };
        return editsOwnAuth(i, updates) ? dropBags(merged) : dropBagsKeepingGuard(merged);
      }
      if (i.items) {
        const res = walk(i.items);
        if (res.changed) {
          changed = true;
          return dropBagsKeepingGuard({ ...i, items: res.items });
        }
      }
      return i;
    });
    return { items: next, changed };
  };
  return { ...col, items: walk(col.items).items };
}

/** Remove item `itemId`; its ancestor folders' cached child lists go stale. */
export function removeItem(col: Collection, itemId: string): Collection {
  const removeIn = (items: CollectionItem[]): CollectionItem[] =>
    items
      .filter((i) => i.id !== itemId)
      .map((i) => (i.items ? { ...i, items: removeIn(i.items) } : i));
  // Ancestors are computed before removal. (A root-level removal where every
  // surviving sibling keeps its bag is not covered here: that needs a
  // root-shortcut staleness change.)
  const staleIds = new Set<string>(ancestorPath(col.items, itemId) ?? []);
  return { ...col, items: stripBagsByIds(removeIn(col.items), staleIds) };
}

/**
 * Reparent into a folder and/or reorder relative to a sibling. Returns `col`
 * itself (same reference) for a no-op: unknown item, non-folder / own-subtree
 * target (cycle), same-parent drop without `beforeId`, or a missing/self/
 * descendant `beforeId`. Source and target ancestor chains plus the moved item
 * lose their bags.
 */
export function moveItem(
  col: Collection,
  itemId: string,
  target: { parentId?: string; beforeId?: string }
): Collection {
  const node = findItem(col.items, itemId);
  if (!node) return col;
  const subtreeIds = collectSubtreeIds(node);

  // Validate BEFORE pruning — an invalid target would otherwise remove the
  // node and fail to reinsert it (data loss).
  if (target.parentId) {
    const parent = findItem(col.items, target.parentId);
    if (parent?.type !== 'folder' || subtreeIds.has(target.parentId)) return col;
    const currentParentId = (ancestorPath(col.items, itemId) ?? []).at(-1);
    if (target.parentId === currentParentId && !target.beforeId) return col;
  }
  if (target.beforeId) {
    if (
      target.beforeId === itemId ||
      subtreeIds.has(target.beforeId) ||
      !findItem(col.items, target.beforeId)
    ) {
      return col;
    }
  }

  const sourceAncestors = ancestorPath(col.items, itemId) ?? [];
  const pruned = removeFromTree(col.items, itemId);
  const inserted = insertIntoTree(pruned, node, target.parentId, target.beforeId);
  // Target ancestors come from the post-move tree so parentId, beforeId (which
  // can land the item in another folder) and root drops resolve uniformly.
  const targetAncestors = ancestorPath(inserted, itemId) ?? [];
  const staleIds = new Set<string>([itemId, ...sourceAncestors, ...targetAncestors]);
  return { ...col, items: stripBagsByIds(inserted, staleIds) };
}

/** Collection fields whose edit makes the root `_postman` sidecar stale. */
const ROOT_SIDECAR_STALE_KEYS = ['auth', 'variables', 'preRequestScript', 'testScript'] as const;

/**
 * Merge root-level `updates` (including a variables edit). The root
 * `_postman` sidecar is cleared when auth / variables / scripts REALLY change
 * (file-collection reloads pass them back unchanged), keeping its send-guard
 * markers unless the root auth itself changed. Root `_oc` is deliberately kept:
 * the OpenCollection exporter re-checks root freshness against the live model.
 */
export function updateRoot(col: Collection, updates: Partial<Collection>): Collection {
  const merged = { ...col, ...updates };
  if (!ROOT_SIDECAR_STALE_KEYS.some((k) => k in updates && !sameValue(updates[k], col[k]))) {
    return merged;
  }
  const authEdited = 'auth' in updates && !sameValue(updates.auth, col.auth);
  const markers = authEdited ? undefined : postmanGuardMarkers(merged);
  clearPostmanSidecar(merged);
  return markers ? attachPostmanSidecar(merged, markers) : merged;
}

/**
 * Prepare a freshly cloned node for duplication, in place: it gets a new
 * identity, so it must not inherit the source's import bags, except the
 * Postman send-guard markers, which keep auth inheritance cut in the copy.
 */
export function stripForDuplicate<T extends object>(node: T): T {
  const markers = postmanGuardMarkers(node);
  deletePassthroughBags(node);
  return markers ? attachPostmanSidecar(node, markers) : node;
}

/**
 * Give a freshly minted `copy` of `source` only the Postman send-guard markers
 * (no other bag travels): a copy of an explicit `noauth` / unsupported-auth
 * request must stay blocked, never inherit. Returns `copy`.
 */
export function carryGuardMarkers<T extends object>(source: object, copy: T): T {
  const markers = postmanGuardMarkers(source);
  return markers ? attachPostmanSidecar(copy, markers) : copy;
}
