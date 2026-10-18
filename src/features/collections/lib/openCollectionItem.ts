import { toast } from 'sonner';
import { useRequestStore } from '@/store/useRequestStore';
import type { CollectionItem } from '@/types';
import { isBrokerRequest } from '@/types';
import { openBrokerPreset } from './brokerPresets';

const opening = new Set<string>();

/**
 * Open a saved collection item — the ONE entry point shared by the sidebar,
 * command palette and deep links. Focuses the tab already linked to the item
 * when there is one; Kafka / MQTT presets (#984) open their connection panel
 * prefilled; every other request opens as a normal request tab.
 *
 * Returns false when the item is not an openable request.
 */
export function openCollectionItem(item: CollectionItem): boolean {
  if (item.type !== 'request' || !item.request) return false;
  const requests = useRequestStore.getState();
  const existing = requests.tabs.find((t) => t.savedRequestId === item.id);
  if (existing) {
    requests.switchTab(existing.id);
    return true;
  }
  if (isBrokerRequest(item.request)) {
    // Credentials are read before the tab opens; ignore repeat clicks meanwhile.
    if (opening.has(item.id)) return true;
    opening.add(item.id);
    openBrokerPreset(item.id, item.request)
      .catch(() => {
        toast.error('Could not open the preset — its saved credentials could not be read');
      })
      .finally(() => opening.delete(item.id));
    return true;
  }
  requests.openTab(item.request, { savedRequestId: item.id, switchTo: true });
  return true;
}
