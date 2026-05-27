import type { CollectionItem, Request } from '@/types';

/**
 * A single executable leaf extracted from a collection tree, preserving the
 * tree's preorder so the runner sends requests top-to-bottom exactly as the
 * user sees them in the sidebar.
 */
export interface RunnableRequest {
  itemId: string;
  name: string;
  request: Request;
}

/** Depth-first preorder flatten of request leaves under `items`. */
function flatten(items: CollectionItem[]): RunnableRequest[] {
  const out: RunnableRequest[] = [];
  for (const item of items) {
    if (item.type === 'request' && item.request) {
      out.push({ itemId: item.id, name: item.name, request: item.request });
    } else if (item.items) {
      out.push(...flatten(item.items));
    }
  }
  return out;
}

/** Find a folder anywhere in the tree by id. */
export function findFolder(items: CollectionItem[], folderId: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === folderId && item.type === 'folder') return item;
    if (item.items) {
      const found = findFolder(item.items, folderId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Flatten a collection (or, when `folderId` is given, a single folder subtree)
 * into an ordered list of runnable requests. Returns `[]` when the folder
 * isn't found.
 */
export function flattenRunnables(
  items: CollectionItem[],
  folderId?: string
): RunnableRequest[] {
  if (!folderId) return flatten(items);
  const folder = findFolder(items, folderId);
  return folder?.items ? flatten(folder.items) : [];
}
