/**
 * Dexie storage adapter for Zustand persist middleware
 * Provides encrypted IndexedDB storage for offline-first, privacy-focused persistence
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { db } from './database';
import {
  encryptValue,
  decryptValue,
  generateLocalEncryptionKey,
  isEncrypted,
  validateEncryptionKey,
  shouldRotateKey,
} from './encryption';
import { isElectron, getElectronAPI } from './platform';

// Storage key for the encryption key
const ENCRYPTION_KEY_STORAGE = 'restura-dexie-encryption-key';

// Key cache timeout (30 minutes of inactivity)
const KEY_CACHE_TIMEOUT_MS = 30 * 60 * 1000;

// Singleton encryption key cache with expiration
interface CachedKey {
  key: string;
  cachedAt: number;
  lastAccessedAt: number;
}

let cachedEncryptionKey: CachedKey | null = null;

/**
 * Check if the cached key has expired due to inactivity
 */
function isKeyCacheExpired(): boolean {
  if (!cachedEncryptionKey) return true;

  const now = Date.now();
  const timeSinceLastAccess = now - cachedEncryptionKey.lastAccessedAt;

  return timeSinceLastAccess > KEY_CACHE_TIMEOUT_MS;
}

/**
 * Update the last accessed time for the cached key
 */
function touchKeyCache(): void {
  if (cachedEncryptionKey) {
    cachedEncryptionKey.lastAccessedAt = Date.now();
  }
}

/**
 * Clear the encryption key cache (call on logout/session end)
 */
export function clearEncryptionKeyCache(): void {
  cachedEncryptionKey = null;
}

/**
 * Store a key in the cache with timestamps
 */
function cacheKey(key: string): void {
  const now = Date.now();
  cachedEncryptionKey = {
    key,
    cachedAt: now,
    lastAccessedAt: now,
  };
}

/**
 * Get or generate the encryption key for Dexie storage
 * Includes key validation, rotation for legacy keys, and cache expiration
 */
async function getEncryptionKey(): Promise<string> {
  // Check if we have a valid cached key
  if (cachedEncryptionKey && !isKeyCacheExpired()) {
    touchKeyCache();
    return cachedEncryptionKey.key;
  }

  // Clear expired cache
  if (isKeyCacheExpired()) {
    cachedEncryptionKey = null;
  }

  if (typeof window === 'undefined') {
    return 'server-fallback-key';
  }

  // For Electron, use safeStorage if available
  if (isElectron()) {
    const api = getElectronAPI();
    if (api?.store) {
      try {
        const storedKey = await api.store.get(ENCRYPTION_KEY_STORAGE);
        if (storedKey) {
          // Validate the stored key
          const validation = validateEncryptionKey(storedKey);
          if (validation.valid) {
            // Check if key needs rotation (legacy format)
            if (shouldRotateKey(storedKey)) {
              console.info('Encryption key uses legacy format, rotation recommended');
              // Note: Actual rotation would require re-encrypting all data
              // For now, we continue using the legacy key but log the recommendation
            }
            cacheKey(storedKey);
            return storedKey;
          } else {
            console.warn('Stored encryption key invalid:', validation.reason);
          }
        }

        // Generate and store new secure key
        const newKey = generateLocalEncryptionKey();
        await api.store.set(ENCRYPTION_KEY_STORAGE, newKey);
        cacheKey(newKey);
        return newKey;
      } catch (error) {
        console.error('Failed to get encryption key from electron-store:', error);
      }
    }
  }

  // Web fallback - store in metadata table
  try {
    const metadata = await db.metadata.get(ENCRYPTION_KEY_STORAGE);
    if (metadata) {
      // Validate the stored key
      const validation = validateEncryptionKey(metadata.value);
      if (validation.valid) {
        // Check if key needs rotation
        if (shouldRotateKey(metadata.value)) {
          console.info('Encryption key uses legacy format, rotation recommended');
        }
        cacheKey(metadata.value);
        return metadata.value;
      } else {
        console.warn('Stored encryption key invalid:', validation.reason);
      }
    }

    // Generate and store new secure key
    const newKey = generateLocalEncryptionKey();
    await db.metadata.put({ key: ENCRYPTION_KEY_STORAGE, value: newKey });
    cacheKey(newKey);
    return newKey;
  } catch (error) {
    console.error('Failed to get encryption key from IndexedDB:', error);
    // Final fallback - generate in-memory key
    const fallbackKey = generateLocalEncryptionKey();
    cacheKey(fallbackKey);
    return fallbackKey;
  }
}

/** Valid table names for storage */
type StorageTableName =
  | 'collections'
  | 'environments'
  | 'history'
  | 'settings'
  | 'cookies'
  | 'workflows'
  | 'workflowExecutions'
  | 'fileCollections';

/**
 * Storage adapter configuration
 */
export interface DexieStorageConfig {
  /** Table name in the database */
  tableName: StorageTableName;
  /** Whether to encrypt the stored data */
  encrypt?: boolean;
}

/**
 * Get table by name with proper typing
 */
function getTable(tableName: StorageTableName) {
  return db[tableName];
}

/**
 * Create a record with all required fields for any table
 */
function createStorageRecord(id: string, encryptedData: string) {
  return {
    id,
    name: id,
    updatedAt: Date.now(),
    encryptedData,
    // Additional fields with defaults for tables that need them
    timestamp: Date.now(),
    method: '',
    url: '',
    domain: '',
    path: '',
    workflowId: '',
    status: 'pending' as const,
    directoryPath: '',
    lastSynced: Date.now(),
  };
}

/**
 * Create a Dexie storage adapter for Zustand persist middleware
 * Stores data encrypted in IndexedDB for unlimited offline storage
 */
export function createDexieStorage<T = unknown>(
  config: DexieStorageConfig
): PersistStorage<T> {
  const { tableName, encrypt = true } = config;

  return {
    getItem: async (name: string): Promise<StorageValue<T> | null> => {
      if (typeof window === 'undefined') return null;

      try {
        const table = getTable(tableName);
        const record = await table.get(name) as { encryptedData?: string } | undefined;

        if (!record?.encryptedData) return null;

        let jsonString = record.encryptedData;

        // Decrypt if necessary
        if (encrypt && isEncrypted(jsonString)) {
          const encryptionKey = await getEncryptionKey();
          try {
            jsonString = await decryptValue(jsonString, encryptionKey);
          } catch (error) {
            console.error(`Decryption failed for ${name}:`, error);
            return null;
          }
        }

        // Parse and return
        return JSON.parse(jsonString) as StorageValue<T>;
      } catch (error) {
        console.error(`Failed to get item ${name} from Dexie:`, error);
        return null;
      }
    },

    setItem: async (name: string, value: StorageValue<T>): Promise<void> => {
      if (typeof window === 'undefined') return;

      try {
        const jsonString = JSON.stringify(value);
        let dataToStore = jsonString;

        // Encrypt if configured
        if (encrypt) {
          const encryptionKey = await getEncryptionKey();
          dataToStore = await encryptValue(jsonString, encryptionKey);
        }

        const table = getTable(tableName);
        const record = createStorageRecord(name, dataToStore);
        await table.put(record);
      } catch (error) {
        console.error(`Failed to set item ${name} in Dexie:`, error);
        throw error;
      }
    },

    removeItem: async (name: string): Promise<void> => {
      if (typeof window === 'undefined') return;

      try {
        const table = getTable(tableName);
        await table.delete(name);
      } catch (error) {
        console.error(`Failed to remove item ${name} from Dexie:`, error);
      }
    },
  };
}

/**
 * Pre-configured storage adapters for each store type
 */
export const dexieStorageAdapters = {
  collections: () =>
    createDexieStorage({
      tableName: 'collections',
      encrypt: true,
    }),

  environments: () =>
    createDexieStorage({
      tableName: 'environments',
      encrypt: true,
    }),

  history: () =>
    createDexieStorage({
      tableName: 'history',
      encrypt: true, // Now encrypted for privacy!
    }),

  settings: () =>
    createDexieStorage({
      tableName: 'settings',
      encrypt: true,
    }),

  cookies: () =>
    createDexieStorage({
      tableName: 'cookies',
      encrypt: true,
    }),

  workflows: () =>
    createDexieStorage({
      tableName: 'workflows',
      encrypt: true,
    }),

  workflowExecutions: () =>
    createDexieStorage({
      tableName: 'workflowExecutions',
      encrypt: true,
    }),

  fileCollections: () =>
    createDexieStorage({
      tableName: 'fileCollections',
      encrypt: true,
    }),
};

/**
 * Check if Dexie storage is available and healthy
 */
export async function checkDexieStorageHealth(): Promise<{
  available: boolean;
  healthy: boolean;
  error?: string;
}> {
  if (typeof window === 'undefined') {
    return { available: false, healthy: false, error: 'Not in browser environment' };
  }

  try {
    // Check if IndexedDB is available
    if (!('indexedDB' in window)) {
      return { available: false, healthy: false, error: 'IndexedDB not available' };
    }

    // Try to open the database
    await db.open();

    // Check if we can read/write
    await db.metadata.put({ key: 'health-check', value: Date.now().toString() });
    const result = await db.metadata.get('health-check');
    await db.metadata.delete('health-check');

    if (!result) {
      return { available: true, healthy: false, error: 'Read/write test failed' };
    }

    return { available: true, healthy: true };
  } catch (error) {
    return {
      available: true,
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Clear all Dexie storage (for logout/reset)
 */
export async function clearDexieStorage(): Promise<void> {
  await db.clearAllData();
  cachedEncryptionKey = null;
}

/**
 * Get Dexie storage statistics
 */
export async function getDexieStorageStats(): Promise<{
  totalRecords: number;
  tables: Record<string, number>;
  estimatedSize: number;
  formattedSize: string;
}> {
  const stats = await db.getStorageStats();

  // Format size
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  return {
    ...stats,
    formattedSize: formatBytes(stats.estimatedSize),
  };
}

/**
 * Export all data for backup
 */
export async function exportDexieData(): Promise<string> {
  const data = await db.exportAllData();
  return JSON.stringify(data);
}

/**
 * Import data from backup
 */
export async function importDexieData(backupJson: string): Promise<void> {
  const backup = JSON.parse(backupJson);
  await db.importAllData(backup);
}

/**
 * Secure delete with overwrite (for privacy)
 */
export async function secureDeleteRecord(
  tableName: StorageTableName,
  id: string
): Promise<void> {
  try {
    const table = getTable(tableName);

    // Overwrite with random data before deleting
    const randomData = crypto.getRandomValues(new Uint8Array(1024));
    const overwriteData = Array.from(randomData)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const record = createStorageRecord(id, overwriteData);
    await table.put(record);

    // Now delete
    await table.delete(id);
  } catch (error) {
    console.error(`Failed to secure delete ${id} from ${tableName}:`, error);
    throw error;
  }
}
