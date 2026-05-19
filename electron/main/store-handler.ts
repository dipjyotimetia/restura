/**
 * Electron store handler for secure persistent storage
 * Uses electron-store with built-in encryption for sensitive data
 */

import { ipcMain } from 'electron';
import {
  StoreKeySchema,
  StoreValueSchema,
  createValidatedHandler,
  validateIpcInput,
} from './ipc-validators';
import { getOrCreateEncryptedKey } from './encrypted-key';

// electron-store v9+ is ESM-only; require() returns the module namespace in Node 22+
const Store = require('electron-store').default;

// Create encrypted store instance with secure key
const store = new Store({
  name: 'restura-encrypted-store',
  encryptionKey: getOrCreateEncryptedKey({
    fileName: '.encryption-key',
    storeLabel: 'credential store',
  }),
  clearInvalidConfig: true, // Clear corrupted data automatically
}) as {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  delete: (key: string) => void;
  clear: () => void;
  has: (key: string) => boolean;
  path: string;
};

/**
 * Register all electron-store IPC handlers
 */
export function registerStoreHandlerIPC(): void {
  ipcMain.handle(
    'store:get',
    createValidatedHandler('store:get', StoreKeySchema, async (key): Promise<string | undefined> => {
      try {
        return store.get(key) as string | undefined;
      } catch (error) {
        console.error(`Failed to get store value for key ${key}:`, error);
        return undefined;
      }
    })
  );

  // store:set takes two args: key and value — validate both
  ipcMain.handle('store:set', async (_event, key: unknown, value: unknown): Promise<void> => {
    const validKey = validateIpcInput(StoreKeySchema, key, 'store:set');
    const validValue = validateIpcInput(StoreValueSchema, value, 'store:set');
    try {
      store.set(validKey, validValue);
    } catch (error) {
      console.error(`Failed to set store value for key ${validKey}:`, error);
      throw error;
    }
  });

  ipcMain.handle(
    'store:delete',
    createValidatedHandler('store:delete', StoreKeySchema, async (key): Promise<void> => {
      try {
        store.delete(key);
      } catch (error) {
        console.error(`Failed to delete store value for key ${key}:`, error);
        throw error;
      }
    })
  );

  ipcMain.handle('store:clear', async (): Promise<void> => {
    try {
      store.clear();
    } catch (error) {
      console.error('Failed to clear store:', error);
      throw error;
    }
  });

  ipcMain.handle(
    'store:has',
    createValidatedHandler('store:has', StoreKeySchema, async (key): Promise<boolean> => {
      try {
        return store.has(key);
      } catch (error) {
        console.error(`Failed to check if store has key ${key}:`, error);
        return false;
      }
    })
  );
}

// Store type definition
interface ElectronStoreInstance {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  delete: (key: string) => void;
  clear: () => void;
  has: (key: string) => boolean;
  path: string;
}

/**
 * Get the store instance for direct access in main process
 */
export function getStore(): ElectronStoreInstance {
  return store;
}
