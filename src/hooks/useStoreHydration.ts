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
    const stores = [
      useRequestStore,
      useEnvironmentStore,
      useSettingsStore,
      useCollectionStore,
      useHistoryStore,
    ];

    let cancelled = false;

    void Promise.all(stores.map((store) => store.persist.rehydrate())).then(() => {
      if (!cancelled) {
        setIsHydrated(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return isHydrated;
}
