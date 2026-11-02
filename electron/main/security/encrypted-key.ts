/**
 * Shared encryption-key derivation for electron-store-backed caches.
 *
 * Both the credential store (store-handler.ts) and the secret-handle store
 * (secret-handle-store.ts) need the same key-management policy: prefer
 * safeStorage (OS keychain), fall back to a 0o600 plaintext key file with
 * a loud warning. Lifting the pattern into one helper keeps the policy
 * consistent — a security fix in one place lands in both.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@shared/runtime/logger';
import { app, safeStorage } from 'electron';

const log = createLogger('keystore');

export interface EncryptedKeyOptions {
  /** File name (without path) for the persisted key blob. */
  fileName: string;
  /** Identifier used in the security warning banner. */
  storeLabel: string;
}

export type KeyStoreMode = 'safeStorage' | 'plaintext';
export type KeyStoreReason = 'no-keyring' | 'decrypt-failed';

export interface KeyStoreStatus {
  mode: KeyStoreMode;
  reason?: KeyStoreReason;
  /** Stores currently in plaintext mode (subset of all opened stores). */
  plaintextStores: string[];
  lastChecked: string;
}

const keyStoreState = new Map<string, { mode: KeyStoreMode; reason?: KeyStoreReason }>();

function recordKeyStoreState(
  storeLabel: string,
  mode: KeyStoreMode,
  reason?: KeyStoreReason
): void {
  keyStoreState.set(storeLabel, reason !== undefined ? { mode, reason } : { mode });
}

/**
 * Snapshot of the aggregated keychain status across every store opened in this
 * session. The mode degrades to `plaintext` if any one store is unprotected —
 * matches user intent ("are my secrets safe?"). Surfaced to the renderer via
 * the `keychain:status` IPC channel.
 */
export function getKeyStoreStatus(): KeyStoreStatus {
  const plaintextEntries = Array.from(keyStoreState.entries()).filter(
    ([, s]) => s.mode === 'plaintext'
  );
  if (plaintextEntries.length === 0) {
    return { mode: 'safeStorage', plaintextStores: [], lastChecked: new Date().toISOString() };
  }
  const firstReason = plaintextEntries[0]?.[1]?.reason;
  return {
    mode: 'plaintext',
    ...(firstReason !== undefined ? { reason: firstReason } : {}),
    plaintextStores: plaintextEntries.map(([label]) => label),
    lastChecked: new Date().toISOString(),
  };
}

function emitFallbackWarning(storeLabel: string, reason: 'no-keyring' | 'decrypt-failed'): void {
  const detail =
    reason === 'no-keyring'
      ? 'Electron safeStorage reports no OS keychain backend (libsecret on Linux, Keychain on macOS, DPAPI on Windows).'
      : 'Existing safeStorage-encrypted key failed to decrypt; rotating to a plaintext fallback.';
  log.warn('SECURITY WARNING: store key is unprotected (stored plaintext in userData)', {
    storeLabel,
    reason,
    detail,
    remediation:
      'On Linux, install gnome-keyring / KWallet / libsecret to restore OS-keychain protection.',
  });
}

function tightenKeyFileMode(keyFile: string): void {
  try {
    if (process.platform === 'win32') return;
    fs.chmodSync(keyFile, 0o600);
  } catch {
    // No file yet or permission error — best-effort only.
  }
}

/** Keys derived by `primeEncryptedKeys`, keyed by key file name. */
const primedKeys = new Map<string, string>();

/**
 * Read an existing key from disk (decrypting via safeStorage when possible),
 * or generate a fresh 32-byte random key and persist it. Resolves to the hex
 * key string suitable for use as an electron-store `encryptionKey`.
 *
 * Uses the async safeStorage API: the sync `encryptString` / `decryptString` /
 * `isEncryptionAvailable` trio is deprecated and slated for removal in
 * Electron 46. Ciphertext is interchangeable between the two APIs (same key
 * store), so key files written by older builds keep decrypting.
 *
 * Uses readFileSync + ENOENT catch instead of existsSync→readFileSync to avoid
 * a TOCTOU race window (academic for an app-private dir, but cheap to remove).
 */
export async function deriveEncryptedKey(opts: EncryptedKeyOptions): Promise<string> {
  const keyFile = path.join(app.getPath('userData'), opts.fileName);

  let encryptedKey: Buffer | null = null;
  try {
    encryptedKey = fs.readFileSync(keyFile);
  } catch (err) {
    // ENOENT: first run, fall through to fresh-key generation.
    // Other errors (EACCES, EISDIR, etc.) also fall through — the write
    // attempt below will surface a more actionable error.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('could not read key file', {
        storeLabel: opts.storeLabel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (encryptedKey !== null) {
    tightenKeyFileMode(keyFile);
    if (await isKeychainAvailable()) {
      try {
        const { result } = await safeStorage.decryptStringAsync(encryptedKey);
        recordKeyStoreState(opts.storeLabel, 'safeStorage');
        return result;
      } catch {
        emitFallbackWarning(opts.storeLabel, 'decrypt-failed');
        recordKeyStoreState(opts.storeLabel, 'plaintext', 'decrypt-failed');
      }
    } else {
      emitFallbackWarning(opts.storeLabel, 'no-keyring');
      recordKeyStoreState(opts.storeLabel, 'plaintext', 'no-keyring');
      return encryptedKey.toString('utf8');
    }
  }

  const newKey = crypto.randomBytes(32).toString('hex');
  try {
    if (await isKeychainAvailable()) {
      fs.writeFileSync(keyFile, await safeStorage.encryptStringAsync(newKey));
      recordKeyStoreState(opts.storeLabel, 'safeStorage');
    } else {
      emitFallbackWarning(opts.storeLabel, 'no-keyring');
      fs.writeFileSync(keyFile, newKey, { mode: 0o600 });
      recordKeyStoreState(opts.storeLabel, 'plaintext', 'no-keyring');
    }
    tightenKeyFileMode(keyFile);
  } catch (err) {
    log.error('failed to write key', {
      storeLabel: opts.storeLabel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return newKey;
}

async function isKeychainAvailable(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Derive every store key once, after `app` is ready and before any IPC handler
 * can touch a store. The async safeStorage API cannot back the synchronous
 * store accessors directly, so this runs the async work up front and
 * `getOrCreateEncryptedKey` serves the result from memory.
 */
export async function primeEncryptedKeys(specs: readonly EncryptedKeyOptions[]): Promise<void> {
  const keys = await Promise.all(specs.map((spec) => deriveEncryptedKey(spec)));
  specs.forEach((spec, i) => {
    primedKeys.set(spec.fileName, keys[i] as string);
  });
}

/**
 * Synchronous accessor for a key derived by `primeEncryptedKeys`. Throws if the
 * key was not primed — a store opened before startup priming would otherwise
 * silently get a different key and fail to decrypt existing data.
 */
export function getOrCreateEncryptedKey(opts: EncryptedKeyOptions): string {
  const key = primedKeys.get(opts.fileName);
  if (key === undefined) {
    throw new Error(
      `encryption key "${opts.fileName}" was not primed — call primeEncryptedKeys() at startup`
    );
  }
  return key;
}

/** Test-only: drop primed keys so tests can re-derive. */
export function __resetPrimedKeysForTests(): void {
  primedKeys.clear();
}
