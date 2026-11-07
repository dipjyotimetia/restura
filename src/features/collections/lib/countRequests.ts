import { type CollectionItem, isConnectionPresetRequest } from '@/types';

/**
 * Requests in a collection tree, counted recursively through folders and
 * excluding connection presets — the same set the run dialog reports
 * (`flattenRunnables`), without building the runnable objects.
 */
/** Folders in a collection tree, counted recursively. */
export function countFolders(items: readonly CollectionItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.type === 'folder') count++;
    if (item.items) count += countFolders(item.items);
  }
  return count;
}

export function countRequests(items: readonly CollectionItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.items && item.items.length > 0) count += countRequests(item.items);
    else if (item.request && !isConnectionPresetRequest(item.request)) count++;
  }
  return count;
}
