import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { CollectionItem } from '@/types';
import { reapBrokerPresetSecretsForItem } from './brokerPresets';
import { countRequests } from './countRequests';
import { collectItemIds } from './deleteCollection';

function findItem(items: readonly CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.items) {
      const found = findItem(item.items, id);
      if (found) return found;
    }
  }
  return undefined;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Remove items (and everything under them) from a collection, dropping
 * stored preset credentials and detaching any open tab that was saved from
 * one of them — otherwise a later save targets a request that no longer
 * exists. Mirrors `deleteCollectionWithCleanup`.
 */
export function deleteCollectionItems(collectionId: string, itemIds: readonly string[]): void {
  const store = useCollectionStore.getState();
  const items = store.getCollectionById(collectionId)?.items ?? [];
  const removedIds = new Set<string>();
  for (const itemId of itemIds) {
    const item = findItem(items, itemId);
    if (item) collectItemIds([item], removedIds);
  }
  for (const itemId of itemIds) {
    // Kafka / MQTT presets: drop their stored credentials too (#984).
    reapBrokerPresetSecretsForItem(items, itemId);
    store.removeCollectionItem(collectionId, itemId);
  }
  if (removedIds.size > 0) useRequestStore.getState().detachTabsFromSavedRequests(removedIds);
}

/** Confirm-dialog copy naming what an item delete removes. */
export function describeItemDeletion(
  collectionId: string,
  itemIds: readonly string[]
): { title: string; description: string } {
  const items = useCollectionStore.getState().getCollectionById(collectionId)?.items ?? [];
  const targets = itemIds
    .map((id) => findItem(items, id))
    .filter((item): item is CollectionItem => item !== undefined);
  const descendants = targets.reduce(
    (sum, item) => sum + (item.items ? collectItemIds(item.items).size : 0),
    0
  );
  const suffix = ' This action cannot be undone.';

  if (targets.length > 1) {
    const names = targets.map((item) => `"${item.name}"`).join(', ');
    const inside = descendants > 0 ? ` and the ${plural(descendants, 'item')} inside them` : '';
    return {
      title: `Delete ${targets.length} items`,
      description: `Delete ${targets.length} selected items (${names})${inside}?${suffix}`,
    };
  }

  const [target] = targets;
  if (!target) {
    return { title: 'Delete item', description: `Delete this item?${suffix}` };
  }
  if (target.type === 'folder') {
    const requests = countRequests(target.items ?? []);
    const inside =
      descendants > 0
        ? ` and the ${plural(descendants, 'item')} inside it (${plural(requests, 'request')})`
        : '';
    return {
      title: `Delete "${target.name}"`,
      description: `Delete the folder "${target.name}"${inside}?${suffix}`,
    };
  }
  return {
    title: `Delete "${target.name}"`,
    description: `Delete the request "${target.name}"?${suffix}`,
  };
}
