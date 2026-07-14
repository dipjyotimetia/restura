import { toast } from 'sonner';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { Request } from '@/types';
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
  if (isNameTaken(request.name, siblingNamesOfItem(collection, savedRequestId))) {
    toast.error(`An item named "${request.name}" already exists at this level`);
    return false;
  }
  store.updateAnyCollectionItem(savedRequestId, { name: request.name, request });
  return true;
}
