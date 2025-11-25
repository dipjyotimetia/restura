/**
 * Electron store handler for secure persistent storage
 * Uses electron-store with built-in encryption for sensitive data
 */

import { ipcMain, app, safeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Use require for electron-store to avoid ESM/CommonJS issues
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Store = require('electron-store');

/**
 * Get or generate encryption key for electron-store
 * Uses safeStorage (OS keychain) if available, otherwise generates a key
 */
function getEncryptionKey(): string {
  const keyFile = path.join(app.getPath('userData'), '.encryption-key');

  // Try to read existing key
  if (fs.existsSync(keyFile)) {
    try {
      const encryptedKey = fs.readFileSync(keyFile);

      // Decrypt with safeStorage if available
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(encryptedKey);
      }

      // Fall back to stored key (less secure but functional)
      return encryptedKey.toString('utf8');
    } catch {
      // Key file corrupted, generate new one
    }
  }

  // Generate new random key
  const newKey = crypto.randomBytes(32).toString('hex');

  try {
    // Encrypt and store with safeStorage if available
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(newKey);
      fs.writeFileSync(keyFile, encrypted);
    } else {
      // Store directly (less secure but functional)
      fs.writeFileSync(keyFile, newKey, { mode: 0o600 });
    }
  } catch (error) {
    console.error('Failed to save encryption key:', error);
  }

  return newKey;
}

// Create encrypted store instance with secure key
const store = new Store({
  name: 'restura-encrypted-store',
  encryptionKey: getEncryptionKey(),
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
  // Get a value from the store
  ipcMain.handle('store:get', async (_event, key: string): Promise<string | undefined> => {
    try {
      const value = store.get(key);
      return value as string | undefined;
    } catch (error) {
      console.error(`Failed to get store value for key ${key}:`, error);
      return undefined;
    }
  });

  // Set a value in the store
  ipcMain.handle('store:set', async (_event, key: string, value: string): Promise<void> => {
    try {
      store.set(key, value);
    } catch (error) {
      console.error(`Failed to set store value for key ${key}:`, error);
      throw error;
    }
  });

  // Delete a value from the store
  ipcMain.handle('store:delete', async (_event, key: string): Promise<void> => {
    try {
      store.delete(key);
    } catch (error) {
      console.error(`Failed to delete store value for key ${key}:`, error);
      throw error;
    }
  });

  // Clear all values from the store
  ipcMain.handle('store:clear', async (): Promise<void> => {
    try {
      store.clear();
    } catch (error) {
      console.error('Failed to clear store:', error);
      throw error;
    }
  });

  // Check if a key exists in the store
  ipcMain.handle('store:has', async (_event, key: string): Promise<boolean> => {
    try {
      return store.has(key);
    } catch (error) {
      console.error(`Failed to check if store has key ${key}:`, error);
      return false;
    }
  });

  // Get store path (useful for debugging)
  ipcMain.handle('store:getPath', async (): Promise<string> => {
    return store.path;
  });

  // Get store size (useful for quota monitoring)
  ipcMain.handle('store:getSize', async (): Promise<number> => {
    try {
      const fs = require('fs');
      const stats = fs.statSync(store.path);
      return stats.size;
    } catch {
      return 0;
    }
  });
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
