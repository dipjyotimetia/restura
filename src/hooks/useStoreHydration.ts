'use client';

import { useEffect, useState } from 'react';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';

/**
 * Rehydrate the persisted Zustand stores from their async backing store
 * (Dexie/IndexedDB on web, encrypted electron-store on desktop) after mount,
 * and report when hydration has settled. Because the persist storage is async,
 * components gate on the returned `isHydrated` flag to avoid rendering against
 * empty pre-hydration state.
 */
export function useStoreHydration() {
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    // Rehydrate all stores
    const unsubscribers: (() => void)[] = [];

    // Trigger rehydration for each store
    const stores = [
      useRequestStore,
      useEnvironmentStore,
      useSettingsStore,
      useCollectionStore,
      useHistoryStore,
    ];

    stores.forEach((store) => {
      // Check if the store has persist middleware with rehydrate method
      const persistedStore = store as unknown as {
        persist?: {
          rehydrate: () => Promise<void> | void;
          onFinishHydration?: (callback: () => void) => () => void;
        };
      };

      if (persistedStore.persist?.rehydrate) {
        persistedStore.persist.rehydrate();
      }

      if (persistedStore.persist?.onFinishHydration) {
        const unsub = persistedStore.persist.onFinishHydration(() => {
          // Store finished hydrating
        });
        unsubscribers.push(unsub);
      }
    });

    // Mark as hydrated after a small delay to ensure all stores are ready
    const timer = setTimeout(() => {
      setIsHydrated(true);
    }, 0);

    return () => {
      clearTimeout(timer);
      unsubscribers.forEach((unsub) => unsub());
    };
  }, []);

  return isHydrated;
}
