/**
 * Storage utilities for Restura
 * - Web: Uses Dexie (IndexedDB) - see dexie-storage.ts
 * - Electron: Uses electron-store via IPC
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { isElectron, getElectronAPI } from './platform';

/**
 * Electron storage adapter using electron-store via IPC
 * For use with non-Dexie stores that need Electron-specific storage
 */
export function createElectronStorage<T>(): PersistStorage<T> {
  return {
    getItem: async (name: string): Promise<StorageValue<T> | null> => {
      const api = getElectronAPI();
      if (!api?.store) {
        console.warn('electron-store IPC not available');
        return null;
      }

      try {
        const result = await api.store.get(name);
        if (!result) return null;
        return JSON.parse(result) as StorageValue<T>;
      } catch (error) {
        console.error(`Failed to get item ${name} from electron-store:`, error);
        return null;
      }
    },

    setItem: async (name: string, value: StorageValue<T>): Promise<void> => {
      const api = getElectronAPI();
      if (!api?.store) {
        console.warn('electron-store IPC not available');
        return;
      }

      try {
        await api.store.set(name, JSON.stringify(value));
      } catch (error) {
        console.error(`Failed to set item ${name} in electron-store:`, error);
        throw error;
      }
    },

    removeItem: async (name: string): Promise<void> => {
      const api = getElectronAPI();
      if (!api?.store) {
        return;
      }

      try {
        await api.store.delete(name);
      } catch (error) {
        console.error(`Failed to remove item ${name} from electron-store:`, error);
      }
    },
  };
}

/**
 * Check if running in Electron environment
 */
export function isElectronEnvironment(): boolean {
  return isElectron();
}

/**
 * Get localStorage usage statistics (for monitoring)
 * Note: Main storage uses IndexedDB (Dexie), this is for legacy monitoring only
 */
export function getStorageStats(): {
  used: number;
  available: number;
  percentage: number;
} {
  if (typeof window === 'undefined') {
    return { used: 0, available: 0, percentage: 0 };
  }

  let totalSize = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      const value = localStorage.getItem(key);
      if (value) {
        totalSize += key.length + value.length;
      }
    }
  }

  // Convert to bytes (UTF-16)
  const usedBytes = totalSize * 2;
  // Typical localStorage limit is 5MB
  const availableBytes = 5 * 1024 * 1024;
  const percentage = (usedBytes / availableBytes) * 100;

  return {
    used: usedBytes,
    available: availableBytes,
    percentage: Math.round(percentage * 100) / 100,
  };
}
