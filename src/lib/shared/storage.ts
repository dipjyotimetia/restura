/**
 * Storage adapter that works across web (localStorage) and Electron
 * This provides a unified interface for persistent storage
 */

import { isElectron } from './platform';

interface StorageAdapter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
}

/**
 * Web storage adapter using localStorage
 */
const webStorageAdapter: StorageAdapter = {
  getItem: (key: string) => {
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem(key);
    } catch {
      console.error('Failed to get item from localStorage');
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(key, value);
    } catch {
      console.error('Failed to set item in localStorage');
    }
  },
  removeItem: (key: string) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(key);
    } catch {
      console.error('Failed to remove item from localStorage');
    }
  },
  clear: () => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.clear();
    } catch {
      console.error('Failed to clear localStorage');
    }
  },
};

/**
 * Electron storage adapter
 * Uses localStorage for now, but can be upgraded to electron-store
 * for better persistence and security
 */
const electronStorageAdapter: StorageAdapter = {
  getItem: (key: string) => {
    if (typeof window === 'undefined') return null;
    try {
      // For now, use localStorage in Electron
      // Can be upgraded to use electron-store via IPC
      return localStorage.getItem(key);
    } catch {
      console.error('Failed to get item from storage');
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(key, value);
    } catch {
      console.error('Failed to set item in storage');
    }
  },
  removeItem: (key: string) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(key);
    } catch {
      console.error('Failed to remove item from storage');
    }
  },
  clear: () => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.clear();
    } catch {
      console.error('Failed to clear storage');
    }
  },
};

/**
 * Get the appropriate storage adapter based on the platform
 */
export function getStorageAdapter(): StorageAdapter {
  if (isElectron()) {
    return electronStorageAdapter;
  }
  return webStorageAdapter;
}

/**
 * Storage utility functions
 */
export const storage = {
  get: (key: string): string | null => {
    return getStorageAdapter().getItem(key);
  },

  set: (key: string, value: string): void => {
    getStorageAdapter().setItem(key, value);
  },

  remove: (key: string): void => {
    getStorageAdapter().removeItem(key);
  },

  clear: (): void => {
    getStorageAdapter().clear();
  },

  /**
   * Get and parse JSON from storage
   */
  getJSON: <T>(key: string, defaultValue: T): T => {
    const value = getStorageAdapter().getItem(key);
    if (!value) return defaultValue;
    try {
      return JSON.parse(value) as T;
    } catch {
      console.error(`Failed to parse JSON for key: ${key}`);
      return defaultValue;
    }
  },

  /**
   * Stringify and save JSON to storage
   */
  setJSON: <T>(key: string, value: T): void => {
    try {
      const stringValue = JSON.stringify(value);
      getStorageAdapter().setItem(key, stringValue);
    } catch {
      console.error(`Failed to stringify JSON for key: ${key}`);
    }
  },
};

/**
 * Create a Zustand persist storage compatible object
 * This can be used with Zustand's persist middleware
 */
export function createZustandStorage() {
  return {
    getItem: (name: string): string | null => {
      return getStorageAdapter().getItem(name);
    },
    setItem: (name: string, value: string): void => {
      getStorageAdapter().setItem(name, value);
    },
    removeItem: (name: string): void => {
      getStorageAdapter().removeItem(name);
    },
  };
}

export type { StorageAdapter };
