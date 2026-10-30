/**
 * Registry of every electron-store encryption key. `primeStoreKeys()` derives
 * all of them (async safeStorage) once at startup; each store then reads its
 * key synchronously through `getOrCreateEncryptedKey(<SPEC>)`. A new
 * encrypted store must add its spec here, or opening it throws.
 */
import { type EncryptedKeyOptions, primeEncryptedKeys } from './encrypted-key';

export const CREDENTIAL_STORE_KEY = {
  fileName: '.encryption-key',
  storeLabel: 'credential store',
} as const satisfies EncryptedKeyOptions;

export const SECRET_HANDLE_STORE_KEY = {
  fileName: '.secret-handles-key',
  storeLabel: 'secret-handle store',
} as const satisfies EncryptedKeyOptions;

export const EXTERNAL_SECRET_PROFILE_STORE_KEY = {
  fileName: '.external-secret-profiles-key',
  storeLabel: 'external secret profile store',
} as const satisfies EncryptedKeyOptions;

export const VAULT_STORE_KEY = {
  fileName: '.vault-key',
  storeLabel: 'pm.vault store',
} as const satisfies EncryptedKeyOptions;

const ALL_STORE_KEYS: readonly EncryptedKeyOptions[] = [
  CREDENTIAL_STORE_KEY,
  SECRET_HANDLE_STORE_KEY,
  EXTERNAL_SECRET_PROFILE_STORE_KEY,
  VAULT_STORE_KEY,
];

/** Call once after `app.whenReady()`, before registering IPC handlers. */
export function primeStoreKeys(): Promise<void> {
  return primeEncryptedKeys(ALL_STORE_KEYS);
}
