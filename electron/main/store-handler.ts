/**
 * Electron store handler for secure persistent storage
 * Uses electron-store with built-in encryption for sensitive data
 */

import { ipcMain } from 'electron';
import { IPC } from '../shared/channels';
import {
  StoreKeySchema,
  StoreSetSchema,
  NoInputSchema,
  createValidatedHandler,
} from './ipc-validators';
import { getOrCreateEncryptedKey } from './encrypted-key';
import { createLogger } from '../../src/lib/shared/logger';

const log = createLogger('store');

// electron-store v9+ is ESM-only; require() returns the module namespace in Node 22+
const Store = require('electron-store').default;

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
 * The store is created LAZILY on first use, not at module import.
 *
 * getOrCreateEncryptedKey() calls safeStorage.isEncryptionAvailable(), which on
 * macOS only returns true AFTER the app emits 'ready'. This module is imported
 * by main.ts before app.whenReady(), so eager creation here derived the key with
 * the keychain "unavailable" — forcing a plaintext-key fallback, the misleading
 * "Secrets are stored without OS-keychain protection" banner, and an unstable
 * key that made previously-encrypted data fail to decrypt. Deferring creation to
 * first use (which always happens after the app is ready) lets safeStorage back
 * the key. Mirrors the lazy pattern in secret-handle-store.ts.
 */
let store: ElectronStoreInstance | null = null;

function getStoreInstance(): ElectronStoreInstance {
  if (!store) {
    store = new Store({
      name: 'restura-encrypted-store',
      encryptionKey: getOrCreateEncryptedKey({
        fileName: '.encryption-key',
        storeLabel: 'credential store',
      }),
      clearInvalidConfig: true, // Clear corrupted data automatically
    }) as ElectronStoreInstance;
  }
  return store;
}

/**
 * Register all electron-store IPC handlers
 */
export function registerStoreHandlerIPC(): void {
  ipcMain.handle(
    IPC.store.get,
    createValidatedHandler(
      IPC.store.get,
      StoreKeySchema,
      async (key): Promise<string | undefined> => {
        try {
          return getStoreInstance().get(key) as string | undefined;
        } catch (error) {
          log.error('store get failed', {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      }
    )
  );

  // store:set takes two args (key, value); createValidatedHandler validates
  // them as a tuple and enforces assertTrustedSender — same pattern as fs:writeFile.
  ipcMain.handle(
    IPC.store.set,
    createValidatedHandler(IPC.store.set, StoreSetSchema, async ([key, value]): Promise<void> => {
      try {
        getStoreInstance().set(key, value);
      } catch (error) {
        log.error('store set failed', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })
  );

  ipcMain.handle(
    IPC.store.delete,
    createValidatedHandler(IPC.store.delete, StoreKeySchema, async (key): Promise<void> => {
      try {
        getStoreInstance().delete(key);
      } catch (error) {
        log.error('store delete failed', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })
  );

  ipcMain.handle(
    IPC.store.clear,
    createValidatedHandler(IPC.store.clear, NoInputSchema, async (): Promise<void> => {
      try {
        getStoreInstance().clear();
      } catch (error) {
        log.error('store clear failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })
  );

  ipcMain.handle(
    IPC.store.has,
    createValidatedHandler(IPC.store.has, StoreKeySchema, async (key): Promise<boolean> => {
      try {
        return getStoreInstance().has(key);
      } catch (error) {
        log.error('store has-check failed', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })
  );
}

/**
 * Get the store instance for direct access in main process.
 * Lazily initialized so the encryption key is derived after the app is ready
 * (when safeStorage / the OS keychain is available).
 */
export function getStore(): ElectronStoreInstance {
  return getStoreInstance();
}
