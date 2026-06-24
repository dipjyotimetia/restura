/**
 * Dexie storage adapter for Zustand persist middleware
 * Provides encrypted IndexedDB storage for offline-first, privacy-focused persistence
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { db } from './database';
import { encryptValue, decryptValue, isEncrypted } from './encryption';
import { getKeyProvider, type KeyProvider } from './keyProvider';

// Singleton encryption key cache
let cachedEncryptionKey: string | null = null;

// Suffix for the backup key holding an undecryptable row's original ciphertext.
// Quarantining (vs. deleting) keeps the data recoverable if the key is later
// fixed; getItem never reads this key, so it doesn't reintroduce the error loop.
const QUARANTINE_SUFFIX = '__undecryptable';

/**
 * Get the encryption key for Dexie storage via the active KeyProvider.
 *
 * Selection happens in keyProvider.ts:
 * - Electron -> ElectronSafeStorageKeyProvider (safeStorage-protected IPC)
 * - Web -> PlaintextKeyProvider (callers should check provider.isEncrypted()
 *   first and skip the round-trip entirely when false)
 *
 * Caches the key locally to avoid repeated provider/IPC round-trips.
 */
async function getEncryptionKey(): Promise<string> {
  if (cachedEncryptionKey) return cachedEncryptionKey;
  if (typeof window === 'undefined') return 'server-fallback-key';
  // No fallback to a generated ephemeral key. Phase 3.4 deleted "ephemeral
  // encryption" precisely because a session-scoped key corrupts data on tab
  // close. If the provider can't return a key, surface that as an error so
  // the storage adapter returns null and the caller sees the failure —
  // better than silently writing data the user can never read back.
  const key = await getKeyProvider().getKey();
  cachedEncryptionKey = key;
  return key;
}

/**
 * Returns the active provider, or null on server. Used by setItem/getItem
 * to short-circuit the encrypt/decrypt path when the provider explicitly
 * declares it is not encrypting (see PlaintextKeyProvider).
 */
function activeKeyProvider(): KeyProvider | null {
  if (typeof window === 'undefined') return null;
  try {
    return getKeyProvider();
  } catch {
    return null;
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
  | 'fileCollections'
  | 'requestTabs'
  | 'websocketConnections'
  | 'sseConnections'
  | 'mcpConnections'
  | 'kafkaConnections'
  | 'mqttConnections'
  | 'socketioConnections'
  | 'console'
  | 'graphqlSchemas'
  | 'protoFiles'
  | 'aiChat'
  | 'aiLab'
  | 'evalRuns'
  | 'arenaRuns'
  | 'collectionRuns'
  | 'globals';

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
export function createDexieStorage<T = unknown>(config: DexieStorageConfig): PersistStorage<T> {
  const { tableName, encrypt = true } = config;

  return {
    getItem: async (name: string): Promise<StorageValue<T> | null> => {
      if (typeof window === 'undefined') return null;

      try {
        const table = getTable(tableName);
        const record = (await table.get(name)) as { encryptedData?: string } | undefined;

        if (!record?.encryptedData) return null;

        let jsonString = record.encryptedData;

        // Decrypt if necessary
        if (encrypt && isEncrypted(jsonString)) {
          const encryptionKey = await getEncryptionKey();
          try {
            jsonString = await decryptValue(jsonString, encryptionKey);
          } catch {
            // The ciphertext can't be decrypted with the current key. This is
            // usually data written under an old/rotated key, but a transient or
            // partial-write corruption is INDISTINGUISHABLE here — so do NOT
            // hard-delete (that would irreversibly destroy recoverable data on a
            // one-off bad read). Instead QUARANTINE: move the ciphertext to a
            // backup key and free the live row so the store hydrates to defaults
            // and re-persists under the current key (stops the per-reload error
            // loop) while keeping the original recoverable if the key is fixed.
            console.warn(
              `[dexie-storage] "${name}" could not be decrypted with the current key; ` +
                `quarantining to "${name}${QUARANTINE_SUFFIX}" and resetting to defaults. ` +
                `If this is unexpected, the original ciphertext is preserved for recovery.`
            );
            try {
              const table = getTable(tableName);
              // `jsonString` still holds the original ciphertext (the failed
              // assignment above never completed). Overwrite any prior backup.
              await table.put(createStorageRecord(`${name}${QUARANTINE_SUFFIX}`, jsonString));
              await table.delete(name);
            } catch {
              /* best-effort quarantine */
            }
            return null;
          }
        }

        // Parse and return — guard against corrupted/partial writes that would
        // otherwise throw and surface as an unhandled rejection in the
        // persist middleware. Treat parse failure as "no record".
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonString);
        } catch (err) {
          console.error(`[dexie-storage] rehydration JSON parse failed for ${name}:`, err);
          return null;
        }
        return parsed as StorageValue<T>;
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

        // Encrypt if configured AND the active provider actually encrypts.
        // PlaintextKeyProvider returns isEncrypted() === false so we skip
        // the round-trip and store JSON as-is. The getItem path already
        // tolerates this because it gates decryption on the "ENC:" prefix
        // (see encryption.ts isEncrypted()) — plaintext flows through.
        const provider = activeKeyProvider();
        if (encrypt && provider?.isEncrypted() !== false) {
          const encryptionKey = await getEncryptionKey();
          dataToStore = await encryptValue(jsonString, encryptionKey);
        }

        const table = getTable(tableName);
        const record = createStorageRecord(name, dataToStore);
        await table.put(record);
      } catch (error) {
        // Log and swallow — persistence is best-effort. Re-throwing escapes
        // zustand's persist middleware as an unhandled rejection in test
        // environments without IndexedDB (jsdom + fake-indexeddb races on
        // module-load cookie hydration). Mirrors getItem/removeItem above.
        if (
          error instanceof Error &&
          (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
        ) {
          window.dispatchEvent(
            new CustomEvent('restura:storage-quota-exceeded', { bubbles: true })
          );
        }
        console.error(`Failed to set item ${name} in Dexie:`, error);
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

  requestTabs: () =>
    createDexieStorage({
      tableName: 'requestTabs',
      encrypt: true,
    }),

  websocketConnections: () =>
    createDexieStorage({ tableName: 'websocketConnections', encrypt: true }),

  sseConnections: () => createDexieStorage({ tableName: 'sseConnections', encrypt: true }),

  mcpConnections: () => createDexieStorage({ tableName: 'mcpConnections', encrypt: true }),

  kafkaConnections: () => createDexieStorage({ tableName: 'kafkaConnections', encrypt: true }),

  mqttConnections: () => createDexieStorage({ tableName: 'mqttConnections', encrypt: true }),

  socketioConnections: () =>
    createDexieStorage({ tableName: 'socketioConnections', encrypt: true }),

  console: () => createDexieStorage({ tableName: 'console', encrypt: true }),

  graphqlSchemas: () => createDexieStorage({ tableName: 'graphqlSchemas', encrypt: true }),

  protoFiles: () => createDexieStorage({ tableName: 'protoFiles', encrypt: true }),

  aiChat: () => createDexieStorage({ tableName: 'aiChat', encrypt: true }),

  // AI Lab (Electron-only) — providers/prompts/datasets/eval-configs and eval
  // run history. Encrypted: holds provider configs (secret-handle refs) and
  // prompt/dataset content.
  aiLab: () => createDexieStorage({ tableName: 'aiLab', encrypt: true }),

  evalRuns: () => createDexieStorage({ tableName: 'evalRuns', encrypt: true }),

  // AI Lab Arena (Electron-only) — pairwise model-vs-model leaderboard runs.
  arenaRuns: () => createDexieStorage({ tableName: 'arenaRuns', encrypt: true }),

  collectionRuns: () => createDexieStorage({ tableName: 'collectionRuns', encrypt: true }),

  globals: () => createDexieStorage({ tableName: 'globals', encrypt: true }),
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
export async function secureDeleteRecord(tableName: StorageTableName, id: string): Promise<void> {
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

// Every persisted table holds encrypted data (all dexieStorageAdapters set
// encrypt: true), so secure-delete overwrites all of them. Derived from the
// adapter registry rather than hand-listed so a newly-added table can't silently
// escape the overwrite and leak recoverable ciphertext.
const ENCRYPTED_TABLES = Object.keys(dexieStorageAdapters) as StorageTableName[];

/**
 * Securely wipe all data: overwrite every record in every encrypted table with
 * random bytes (so freed IndexedDB pages can't yield recoverable ciphertext),
 * then clear the database. Overwrites in one bulk write per table; the actual
 * deletion + key-cache reset is deferred to {@link clearDexieStorage}.
 */
export async function secureDeleteAllDexieData(): Promise<void> {
  for (const tableName of ENCRYPTED_TABLES) {
    const ids = (await getTable(tableName).toCollection().primaryKeys()) as string[];
    // Overwrite a table's records concurrently; tables stay sequential to bound
    // peak memory. clearDexieStorage then does the final wipe + key-cache reset.
    await Promise.all(ids.map((id) => secureDeleteRecord(tableName, id)));
  }
  await clearDexieStorage();
}
