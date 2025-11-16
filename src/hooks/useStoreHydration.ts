'use client';

import { useEffect, useState } from 'react';
import { useRequestStore } from '@/store/useRequestStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';

/**
 * Hook to rehydrate all Zustand stores from localStorage after client mount.
 * This prevents SSR/CSR hydration mismatches.
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
