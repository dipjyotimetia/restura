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

export interface EncryptedKeyOptions {
  /** File name (without path) for the persisted key blob. */
  fileName: string;
  /** Identifier used in the security warning banner. */
  storeLabel: string;
}

function emitFallbackWarning(storeLabel: string, reason: 'no-keyring' | 'decrypt-failed'): void {
  const banner = '='.repeat(72);
  const detail =
    reason === 'no-keyring'
      ? 'Electron safeStorage reports no OS keychain backend (libsecret on Linux, Keychain on macOS, DPAPI on Windows).'
      : 'Existing safeStorage-encrypted key failed to decrypt; rotating to a plaintext fallback.';
  console.warn(`\n${banner}`);
  console.warn(`[restura] SECURITY WARNING — ${storeLabel} key is unprotected`);
  console.warn(`[restura] ${detail}`);
  console.warn('[restura] The key is stored *plaintext* in the userData directory.');
  console.warn('[restura] On Linux, install gnome-keyring / KWallet / libsecret to restore protection.');
  console.warn(`${banner}\n`);
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
 */
export function getOrCreateEncryptedKey(opts: EncryptedKeyOptions): string {
  const keyFile = path.join(app.getPath('userData'), opts.fileName);

  if (fs.existsSync(keyFile)) {
    tightenKeyFileMode(keyFile);
    try {
      const encryptedKey = fs.readFileSync(keyFile);
      if (safeStorage.isEncryptionAvailable()) {
        try {
          return safeStorage.decryptString(encryptedKey);
        } catch {
          emitFallbackWarning(opts.storeLabel, 'decrypt-failed');
        }
      } else {
        emitFallbackWarning(opts.storeLabel, 'no-keyring');
        return encryptedKey.toString('utf8');
      }
    } catch {
      // Corrupted file — fall through to regeneration.
    }
  }

  const newKey = crypto.randomBytes(32).toString('hex');
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(keyFile, safeStorage.encryptString(newKey));
    } else {
      emitFallbackWarning(opts.storeLabel, 'no-keyring');
      fs.writeFileSync(keyFile, newKey, { mode: 0o600 });
    }
    tightenKeyFileMode(keyFile);
  } catch (err) {
    console.error(`[restura] failed to write ${opts.storeLabel} key:`, err);
  }
  return newKey;
}
