import { toast } from 'sonner';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { CollectionItem, Request } from '@/types';
import { isBrokerRequest } from '@/types';
import { isNameTaken, siblingNamesOfItem } from './names';

/**
 * Save a dirty tab's request back to its saved collection item — the ONE
 * entry point for this mutation (TabBar save button and the mod+s shortcut).
 * Saving back also renames the item to the tab's name, so it refuses (with a
 * toast) when that name would collide with a sibling.
 *
 * Returns true when saved; callers clear the tab's dirty flag on success.
 */
export function saveTabBackToCollection(request: Request, savedRequestId: string): boolean {
  const store = useCollectionStore.getState();
  const collection = store.getCollectionByItemId(savedRequestId);
  if (!collection) {
    toast.error('The saved collection request no longer exists');
    return false;
  }
  const existing = findItem(collection.items, savedRequestId);
  if (existing?.request && isBrokerRequest(existing.request)) {
    // A Kafka / MQTT tab's request is only an HTTP placeholder; writing it back
    // would replace the saved connection preset (#984).
    toast.error('Use Save to Collection to store a new copy of this Kafka / MQTT preset');
    return false;
  }
  if (isNameTaken(request.name, siblingNamesOfItem(collection, savedRequestId))) {
    toast.error(`An item named "${request.name}" already exists at this level`);
    return false;
  }
  store.updateAnyCollectionItem(savedRequestId, { name: request.name, request });
  return true;
}

function findItem(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const nested = item.items ? findItem(item.items, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}
