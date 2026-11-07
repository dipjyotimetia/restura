import { useCollectionStore } from '@/store/useCollectionStore';
import { useFileCollectionStore } from '@/store/useFileCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { CollectionItem } from '@/types';
import { reapBrokerPresetSecrets } from './brokerPresets';
import { countRequests } from './countRequests';

export function collectItemIds(items: CollectionItem[], ids = new Set<string>()): Set<string> {
  for (const item of items) {
    ids.add(item.id);
    if (item.items) collectItemIds(item.items, ids);
  }
  return ids;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Confirm-dialog copy for deleting a collection: names it and spells out
 * everything `deleteCollectionWithCleanup` takes with it (requests, linked
 * workflows) and what it leaves behind (open tabs, files on disk).
 */
export function describeCollectionDeletion(collectionId: string): string {
  const collection = useCollectionStore.getState().getCollectionById(collectionId);
  if (!collection) return 'Delete this collection? This action cannot be undone.';
  const workflowCount = useWorkflowStore
    .getState()
    .workflows.filter((workflow) => workflow.collectionId === collectionId).length;
  const fileInfo = useFileCollectionStore.getState().getFileInfo(collectionId);
  const parts = [
    `Delete "${collection.name}" with ${plural(countRequests(collection.items), 'request')}`,
  ];
  if (workflowCount > 0) parts.push(` and its ${plural(workflowCount, 'linked workflow')}`);
  let text = `${parts.join('')}? Open tabs stay open as unsaved copies.`;
  if (fileInfo) {
    text += ` The files in ${fileInfo.directoryPath} stay on disk; Restura stops tracking them. This cannot be undone.`;
  }
  return text;
}

export interface CollectionDeletionUndo {
  /** Put the collection and its linked workflows back. */
  restore: () => void;
  /** The undo window closed: drop the stored preset credentials for good. */
  finalize: () => void;
}

/**
 * Delete a collection as one coordinated lifecycle operation. Historical
 * collection runs are intentionally untouched so past evidence remains
 * inspectable after its source collection is removed.
 *
 * With `undoable`, an in-memory (not file-backed) collection returns an
 * `undo` handle: preset credentials are reaped only on `finalize`, so
 * `restore` brings the collection back whole.
 */
export async function deleteCollectionWithCleanup(
  collectionId: string,
  options: { undoable?: boolean } = {}
): Promise<{ success: boolean; error?: string; undo?: CollectionDeletionUndo }> {
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

  const workflowStore = useWorkflowStore.getState();
  const workflows = workflowStore.getWorkflowsByCollectionId(collectionId);
  const itemIds = collectItemIds(collection.items);
  useRequestStore.getState().detachTabsFromSavedRequests(itemIds);
  workflowStore.removeWorkflowsByCollectionId(collectionId);
  if (fileInfo) fileStore.unregisterFileCollection(collectionId);
  collectionStore.removeCollection(collectionId);

  if (!options.undoable || fileInfo) {
    // Kafka / MQTT presets: drop their stored credentials too (#984).
    reapBrokerPresetSecrets(collection.items);
    return { success: true };
  }

  let settled = false;
  return {
    success: true,
    undo: {
      restore: () => {
        if (settled) return;
        settled = true;
        useCollectionStore.getState().addCollection(collection);
        const { addWorkflow } = useWorkflowStore.getState();
        for (const workflow of workflows) addWorkflow(workflow);
      },
      finalize: () => {
        if (settled) return;
        settled = true;
        reapBrokerPresetSecrets(collection.items);
      },
    },
  };
}
