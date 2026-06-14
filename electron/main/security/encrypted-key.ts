/**
 * Shared encryption-key derivation for electron-store-backed caches.
 *
 * Both the credential store (store-handler.ts) and the secret-handle store
 * (secret-handle-store.ts) need the same key-management policy: prefer
 * safeStorage (OS keychain), fall back to a 0o600 plaintext key file with
 * a loud warning. Lifting the pattern into one helper keeps the policy
 * consistent — a security fix in one place lands in both.
 */

import { app, safeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../../src/lib/shared/logger';

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

/**
 * Read an existing key from disk (decrypting via safeStorage when possible),
 * or generate a fresh 32-byte random key and persist it. Returns the hex
 * key string suitable for use as an electron-store `encryptionKey`.
 *
 * Uses readFileSync + ENOENT catch instead of existsSync→readFileSync to avoid
 * a TOCTOU race window (academic for an app-private dir, but cheap to remove).
 */
export function getOrCreateEncryptedKey(opts: EncryptedKeyOptions): string {
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
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(encryptedKey);
        recordKeyStoreState(opts.storeLabel, 'safeStorage');
        return decrypted;
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
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(keyFile, safeStorage.encryptString(newKey));
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
