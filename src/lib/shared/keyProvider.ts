import { generateLocalEncryptionKey } from './encryption';
import { isElectron, getElectronAPI } from './platform';

export interface KeyProvider {
  getKey(): Promise<string>;
  /** True if the key is protected by OS-level secure storage (keychain, libsecret, etc). */
  readonly isHardwareBacked: boolean;
  /** Human-readable label for the UI (e.g. "macOS Keychain", "Session passphrase"). */
  readonly label: string;
}

/**
 * Default fallback. Generates a random key on first use and keeps it in memory.
 * NOT hardware-backed — equivalent to the pre-Plan-3 TOFU behaviour. Use only
 * when no better provider is available (tests, dev-mode, web users who explicitly
 * skip the passphrase prompt).
 */
export class EphemeralKeyProvider implements KeyProvider {
  readonly isHardwareBacked = false;
  readonly label = 'Ephemeral (in-memory)';
  private cached: string | null = null;

  async getKey(): Promise<string> {
    if (this.cached === null) this.cached = generateLocalEncryptionKey();
    return this.cached;
  }
}

/**
 * Web provider that derives the key from a user-supplied passphrase via PBKDF2.
 * The key lives in memory only; on a fresh page load the user re-enters the
 * passphrase or proceeds without encryption (EphemeralKeyProvider).
 *
 * Salt is constant per app to keep re-derivation deterministic across sessions
 * without requiring users to remember a separate salt. Iteration count is 100k
 * (matches the existing encryption.ts settings).
 */
export class WebSessionPassphraseProvider implements KeyProvider {
  readonly isHardwareBacked = false;
  readonly label = 'Session passphrase';
  private static singletonKey: string | null = null;

  static reset(): void {
    WebSessionPassphraseProvider.singletonKey = null;
  }

  async setPassphrase(passphrase: string): Promise<void> {
    if (!passphrase) throw new Error('Passphrase must not be empty');
    const SALT = new TextEncoder().encode('restura/v1/passphrase');
    const passBytes = new TextEncoder().encode(passphrase);
    const material = await crypto.subtle.importKey(
      'raw',
      passBytes,
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: SALT as BufferSource,
        iterations: 100_000,
        hash: 'SHA-256',
      },
      material,
      256
    );
    const hex = Array.from(new Uint8Array(bits))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    WebSessionPassphraseProvider.singletonKey = hex;
  }

  async getKey(): Promise<string> {
    if (WebSessionPassphraseProvider.singletonKey === null) {
      throw new Error('No passphrase set. Call setPassphrase first or use EphemeralKeyProvider.');
    }
    return WebSessionPassphraseProvider.singletonKey;
  }
}

/**
 * Minimal IPC contract for the Electron secureKey channel. Mirrors the API
 * exposed in electron/main/key-store.ts (Task 2).
 */
export interface SecureKeyIpc {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * Electron provider that persists the key via electron.safeStorage (keychain on
 * macOS, Credential Manager on Windows, libsecret on Linux). Hardware-backed.
 *
 * Caches the key in memory after the first IPC fetch so subsequent reads avoid
 * the round-trip cost.
 */
export class ElectronSafeStorageKeyProvider implements KeyProvider {
  readonly isHardwareBacked = true;
  readonly label = 'OS keychain (secure storage)';
  private cached: string | null = null;
  private storeKey = 'restura-encryption-key';

  constructor(private ipc: SecureKeyIpc) {}

  async getKey(): Promise<string> {
    if (this.cached !== null) return this.cached;
    const exists = await this.ipc.has(this.storeKey);
    if (exists) {
      const v = await this.ipc.get(this.storeKey);
      if (v) {
        this.cached = v;
        return v;
      }
    }
    const fresh = generateLocalEncryptionKey();
    await this.ipc.set(this.storeKey, fresh);
    this.cached = fresh;
    return fresh;
  }
}

let activeProvider: KeyProvider | null = null;

/**
 * Lazily resolve the active KeyProvider for the current environment.
 *
 * Selection rules:
 * - Electron with `electronAPI.store` available -> ElectronSafeStorageKeyProvider
 *   backed by the existing safeStorage-protected electron-store IPC.
 * - Web (or Electron without store IPC) -> EphemeralKeyProvider as the default.
 *   Task 4's UI calls setKeyProvider(new WebSessionPassphraseProvider()) after
 *   the user supplies a passphrase.
 *
 * Once resolved, the provider is cached for the lifetime of the module.
 * setKeyProvider() lets callers swap in a different provider (used by the
 * web passphrase UI to upgrade Ephemeral -> WebSessionPassphrase).
 */
export function getKeyProvider(): KeyProvider {
  if (activeProvider) return activeProvider;
  if (isElectron()) {
    const api = getElectronAPI();
    if (api?.store) {
      activeProvider = new ElectronSafeStorageKeyProvider({
        get: api.store.get.bind(api.store),
        set: api.store.set.bind(api.store),
        has: api.store.has.bind(api.store),
      });
      return activeProvider;
    }
  }
  activeProvider = new EphemeralKeyProvider();
  return activeProvider;
}

export function setKeyProvider(provider: KeyProvider): void {
  activeProvider = provider;
}

/** Test-only: clear the cached provider so the next getKeyProvider() re-resolves. */
export function __resetKeyProviderForTests(): void {
  activeProvider = null;
}
