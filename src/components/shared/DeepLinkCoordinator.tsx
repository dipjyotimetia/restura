import type { DeepLinkPayload } from '@shared/deep-link';
import type { CollectionItem } from '@shared/types/collection';
import { useEffect, useRef } from 'react';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';

function findRequest(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id && item.type === 'request' && item.request) return item;
    if (item.items) {
      const found = findRequest(item.items, id);
      if (found) return found;
    }
  }
  return undefined;
}

function dispatch(name: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
}

function applyDeepLink(payload: DeepLinkPayload): boolean {
  switch (payload.kind) {
    case 'import':
      dispatch('restura:deep-link-import', { url: payload.url, format: payload.format });
      return true;
    case 'environment': {
      const state = useEnvironmentStore.getState();
      if (!state.environments.some((environment) => environment.id === payload.id)) return false;
      state.setActiveEnvironment(payload.id);
      dispatch('restura:open-environments');
      return true;
    }
    case 'collection': {
      const state = useCollectionStore.getState();
      if (!state.getCollectionById(payload.id)) return false;
      state.setActiveCollection(payload.id);
      return true;
    }
    case 'request': {
      const collection = useCollectionStore.getState().getCollectionByItemId(payload.id);
      const item = collection ? findRequest(collection.items, payload.id) : undefined;
      if (!item?.request) return false;
      const requests = useRequestStore.getState();
      const existing = requests.tabs.find((tab) => tab.savedRequestId === payload.id);
      if (existing) requests.switchTab(existing.id);
      else requests.openTab(item.request, { savedRequestId: payload.id });
      return true;
    }
    case 'settings':
      dispatch('restura:open-settings', payload.section);
      return true;
  }
}

/** Mount once: translate typed, acknowledged OS links into existing UI actions. */
export function DeepLinkCoordinator() {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    if (!api?.deepLinks) return;
    return api.deepLinks.subscribe((payload) => {
      if (seen.current.has(payload.id)) {
        void api.deepLinks.acknowledge(payload.id);
        return;
      }
      seen.current.add(payload.id);
      // The root is mounted after Router initialization. Persisted state may
      // still hydrate, so retry once it completes rather than accepting IDs
      // against an incomplete in-memory store.
      let delivered = false;
      const deliver = () => {
        if (delivered) return;
        delivered = true;
        applyDeepLink(payload);
        void api.deepLinks.acknowledge(payload.id);
      };
      if (useCollectionStore.persist.hasHydrated() && useEnvironmentStore.persist.hasHydrated()) {
        deliver();
        return;
      }
      const unsubs = [
        useCollectionStore.persist.onFinishHydration(deliver),
        useEnvironmentStore.persist.onFinishHydration(deliver),
      ];
      // The preload subscription owns cleanup; hydration callbacks are one-shot
      // after `delivered`, so no listener can mutate state twice.
      void unsubs;
    });
  }, []);
  return null;
}
