import { findFolder } from './flattenRunnables';
import type { Collection, CollectionItem } from '@/types';

/**
 * Duplicate-name policy for the collection tree:
 * - collection names are unique across all collections
 * - item (folder/request) names are unique among their siblings
 *
 * Comparison is trimmed and case-insensitive so "auth" vs "Auth" doesn't
 * create two visually-identical entries; stored names keep their casing.
 */

const norm = (name: string) => name.trim().toLowerCase();

export function isNameTaken(name: string, existing: string[]): boolean {
  const n = norm(name);
  return existing.some((e) => norm(e) === n);
}

/**
 * Return `desired` if free, otherwise the first free "desired 2",
 * "desired 3", … Used by the auto-named create/duplicate flows so they
 * never mint a sibling-colliding name.
 */
export function uniqueName(desired: string, existing: string[]): string {
  const taken = new Set(existing.map(norm));
  if (!taken.has(norm(desired))) return desired;
  let counter = 2;
  while (taken.has(norm(`${desired} ${counter}`))) counter++;
  return `${desired} ${counter}`;
}

/** The array of items that directly contains `itemId`, wherever it nests. */
function findContainingItems(
  items: CollectionItem[],
  itemId: string
): CollectionItem[] | undefined {
  if (items.some((i) => i.id === itemId)) return items;
  for (const item of items) {
    if (item.items) {
      const found = findContainingItems(item.items, itemId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Names of the items a new child of `parentId` (or the collection root)
 * would sit next to.
 */
export function siblingNamesForParent(collection: Collection, parentId?: string): string[] {
  const parentItems = parentId
    ? (findFolder(collection.items, parentId)?.items ?? [])
    : collection.items;
  return parentItems.map((i) => i.name);
}

/**
 * Names of `itemId`'s siblings, excluding the item itself — the set a
 * rename of that item must not collide with.
 */
export function siblingNamesOfItem(collection: Collection, itemId: string): string[] {
  const level = findContainingItems(collection.items, itemId);
  return level ? level.filter((i) => i.id !== itemId).map((i) => i.name) : [];
}

/** The collection whose tree contains `itemId`, if any. */
export function collectionContainingItem(
  collections: Collection[],
  itemId: string
): Collection | undefined {
  return collections.find((c) => findContainingItems(c.items, itemId) !== undefined);
}

/**
 * Would moving `itemId` to `target` (a folder, before another item, or the
 * root) land it next to a same-named sibling? Same-level reorders never
 * collide — the item is excluded from the check by id.
 */
export function moveWouldCollide(
  collection: Collection,
  itemId: string,
  target: { parentId?: string; beforeId?: string }
): boolean {
  const item = findContainingItems(collection.items, itemId)?.find((i) => i.id === itemId);
  if (!item) return false;
  const targetItems = target.beforeId
    ? findContainingItems(collection.items, target.beforeId)
    : target.parentId
      ? findFolder(collection.items, target.parentId)?.items
      : collection.items;
  if (!targetItems) return false;
  return targetItems.some((s) => s.id !== itemId && norm(s.name) === norm(item.name));
}
