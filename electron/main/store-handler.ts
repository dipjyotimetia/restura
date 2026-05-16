/**
 * Electron store handler for secure persistent storage
 * Uses electron-store with built-in encryption for sensitive data
 */

import { ipcMain, app, safeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  StoreKeySchema,
  StoreValueSchema,
  createValidatedHandler,
  validateIpcInput,
} from './ipc-validators';

// electron-store v9+ is ESM-only; require() returns the module namespace in Node 22+
const Store = require('electron-store').default;

/**
 * Loud, single-source warning printed when we have to fall back to the
 * plaintext key file. Common on Linux systems without libsecret / a session
 * keyring. The store contents (secrets, auth tokens, env vars) are only as
 * private as filesystem ACLs in this state.
 */
function emitSafeStorageFallbackWarning(reason: 'no-keyring' | 'decrypt-failed'): void {
  const banner = '='.repeat(72);
  const detail =
    reason === 'no-keyring'
      ? 'Electron safeStorage reports no OS keychain backend (libsecret on Linux, Keychain on macOS, DPAPI on Windows).'
      : 'Existing safeStorage-encrypted key failed to decrypt; rotating to a plaintext fallback.';
  console.warn(`\n${banner}`);
  console.warn('[restura] SECURITY WARNING — encrypted store key is unprotected');
  console.warn(`[restura] ${detail}`);
  console.warn('[restura] The encryption key for the credential store is stored *plaintext*');
  console.warn('[restura] in the userData directory; anyone with read access can decrypt the store.');
  console.warn('[restura] On Linux, install gnome-keyring / KWallet / libsecret to restore protection.');
  console.warn(`${banner}\n`);
}

/**
 * Best-effort: tighten existing key file mode to 0o600 if a previous
 * version wrote it world-readable. fchmod fails silently on Windows (POSIX
 * semantics don't apply) — that's fine.
 */
function tightenKeyFileMode(keyFile: string): void {
  try {
    if (process.platform === 'win32') return;
    fs.chmodSync(keyFile, 0o600);
  } catch {
    // No file yet or permission error — best-effort only.
  }
}

/**
 * Get or generate encryption key for electron-store. Uses safeStorage (OS
 * keychain) when available; otherwise generates a key and writes it with
 * 0o600 permissions, accompanied by a prominent console warning.
 */
function getEncryptionKey(): string {
  const keyFile = path.join(app.getPath('userData'), '.encryption-key');

  // Try to read existing key
  if (fs.existsSync(keyFile)) {
    tightenKeyFileMode(keyFile);
    try {
      const encryptedKey = fs.readFileSync(keyFile);

      // Decrypt with safeStorage if available
      if (safeStorage.isEncryptionAvailable()) {
        try {
          return safeStorage.decryptString(encryptedKey);
        } catch {
          // Existing file was written before safeStorage worked, or its key
          // material no longer matches (keychain reset). Surface a warning
          // and rotate to a fresh key below.
          emitSafeStorageFallbackWarning('decrypt-failed');
        }
      } else {
        // Treat as plaintext key (this app's prior runs wrote it this way).
        emitSafeStorageFallbackWarning('no-keyring');
        return encryptedKey.toString('utf8');
      }
    } catch {
      // Key file corrupted, generate new one
    }
  }

  // Generate new random key
  const newKey = crypto.randomBytes(32).toString('hex');

  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(newKey);
      fs.writeFileSync(keyFile, encrypted);
    } else {
      emitSafeStorageFallbackWarning('no-keyring');
      fs.writeFileSync(keyFile, newKey, { mode: 0o600 });
    }
    tightenKeyFileMode(keyFile);
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
