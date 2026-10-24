import { toast } from 'sonner';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { CollectionItem, Request, RequestTab } from '@/types';
import { isBrokerMode, isBrokerRequest } from '@/types';
import { snapshotBrokerTab, USERINFO_STRIPPED_WARNING } from './brokerPresets';
import { isNameTaken, siblingNamesOfItem } from './names';

/** Tabs whose save-back may target a Kafka / MQTT preset rather than `request`. */
export function isBrokerPresetTab(
  tab: Pick<RequestTab, 'modeOverride' | 'savedRequestId'>
): boolean {
  return !!tab.savedRequestId && isBrokerMode(tab.modeOverride);
}

/**
 * Save a tab back to its saved collection item — the ONE entry point for this
 * mutation (TabBar save button / menu and the mod+s shortcut). Saving back also
 * renames the item to the tab's name, so it refuses (with a toast) when that
 * name would collide with a sibling.
 *
 * A Kafka / MQTT tab linked to a preset (#984) re-snapshots its live connection
 * into the preset — same request id, so its secure-storage credential scope is
 * kept and refreshed. Without `tab` (or for a non-broker tab) a preset is never
 * overwritten with the tab's HTTP placeholder.
 *
 * Returns true when saved; callers clear the tab's dirty flag on success.
 */
export function saveTabBackToCollection(
  request: Request,
  savedRequestId: string,
  tab?: Pick<RequestTab, 'id' | 'modeOverride'>
): boolean {
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
  const existing = findItem(collection.items, savedRequestId);
  if (existing?.request && isBrokerRequest(existing.request)) {
    const snapshot =
      tab?.modeOverride === existing.request.type
        ? snapshotBrokerTab(tab, request.name, existing.request.id)
        : null;
    if (!snapshot) {
      // The tab's request is only an HTTP placeholder; writing it back would
      // replace the saved connection preset.
      toast.error('Open this Kafka / MQTT preset in its own tab to save changes to it');
      return false;
    }
    if (snapshot.strippedUserinfo) toast.warning(USERINFO_STRIPPED_WARNING);
    store.updateAnyCollectionItem(savedRequestId, {
      name: request.name,
      request: snapshot.request,
    });
    snapshot.persistSecrets().catch(() => {
      toast.error('Saved without credentials — re-enter them after opening the preset');
    });
    return true;
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
