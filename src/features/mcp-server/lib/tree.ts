/** Collection-tree lookups for the control tools (pure). */

import type { Collection, CollectionItem } from '@/types';

export interface LocatedItem {
  collection: Collection;
  item: CollectionItem;
  /** Folder names from the collection root to the item's parent. */
  path: string[];
  /** Id of the parent folder, or undefined at the collection root. */
  parentId: string | undefined;
}

function walk(
  items: CollectionItem[],
  itemId: string,
  path: string[],
  parentId: string | undefined
): Omit<LocatedItem, 'collection'> | undefined {
  for (const item of items) {
    if (item.id === itemId) return { item, path, parentId };
    if (item.type === 'folder' && item.items) {
      const found = walk(item.items, itemId, [...path, item.name], item.id);
      if (found) return found;
    }
  }
  return undefined;
}

export function locateItem(
  collections: readonly Collection[],
  itemId: string
): LocatedItem | undefined {
  for (const collection of collections) {
    const found = walk(collection.items, itemId, [], undefined);
    if (found) return { collection, ...found };
  }
  return undefined;
}

export function collectItemIds(item: CollectionItem, ids = new Set<string>()): Set<string> {
  ids.add(item.id);
  for (const child of item.items ?? []) collectItemIds(child, ids);
  return ids;
}

export function someItem(item: CollectionItem, test: (item: CollectionItem) => boolean): boolean {
  if (test(item)) return true;
  return (item.items ?? []).some((child) => someItem(child, test));
}

export function isDescendant(ancestor: CollectionItem, candidateId: string): boolean {
  return (ancestor.items ?? []).some(
    (child) => child.id === candidateId || isDescendant(child, candidateId)
  );
}

export interface TreeNode {
  id: string;
  name: string;
  type: 'folder' | 'request';
  requestType?: string;
  method?: string;
  url?: string;
  children?: TreeNode[];
}
