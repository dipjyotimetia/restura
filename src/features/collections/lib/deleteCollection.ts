import { useCollectionStore } from '@/store/useCollectionStore';
import { useFileCollectionStore } from '@/store/useFileCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { CollectionItem } from '@/types';

function collectItemIds(items: CollectionItem[], ids = new Set<string>()): Set<string> {
  for (const item of items) {
    ids.add(item.id);
    if (item.items) collectItemIds(item.items, ids);
  }
  return ids;
}

/**
 * Delete a collection as one coordinated lifecycle operation. Historical
 * collection runs are intentionally untouched so past evidence remains
 * inspectable after its source collection is removed.
 */
export async function deleteCollectionWithCleanup(
  collectionId: string
): Promise<{ success: boolean; error?: string }> {
  const collectionStore = useCollectionStore.getState();
  const collection = collectionStore.getCollectionById(collectionId);
  if (!collection) return { success: false, error: 'Collection not found' };

  const fileStore = useFileCollectionStore.getState();
  const fileInfo = fileStore.getFileInfo(collectionId);
  if (fileInfo) {
    const collectionsApi = window.electron?.collections;
    if (!collectionsApi) return { success: false, error: 'Desktop collection bridge unavailable' };
    try {
      const stopped = await collectionsApi.unwatchDirectory(fileInfo.directoryPath);
      if (!stopped.success) {
        return { success: false, error: stopped.error ?? 'Failed to stop file watcher' };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const itemIds = collectItemIds(collection.items);
  useRequestStore.getState().detachTabsFromSavedRequests(itemIds);
  useWorkflowStore.getState().removeWorkflowsByCollectionId(collectionId);
  if (fileInfo) fileStore.unregisterFileCollection(collectionId);
  collectionStore.removeCollection(collectionId);
  return { success: true };
}
