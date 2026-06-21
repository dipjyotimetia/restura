import { generateLocalEncryptionKey } from './encryption';
import { isElectron, getElectronAPI } from './platform';

export interface KeyProvider {
  getKey(): Promise<string>;
  /** True if the key is protected by OS-level secure storage (keychain, libsecret, etc). */
  readonly isHardwareBacked: boolean;
  /** Human-readable label for the UI (e.g. "macOS Keychain", "Session passphrase"). */
  readonly label: string;
  /**
   * True if the provider supplies a real encryption key whose loss would render
   * stored data unrecoverable. False for the plaintext provider, which means
   * dexie-storage can short-circuit the encrypt/decrypt round-trip and store
   * raw JSON. Used by `src/lib/shared/dexie-storage.ts` to skip crypto for the
   * web default. See `docs/security.md` for policy.
   */
  isEncrypted(): boolean;
}

/**
 * Web default. Returns a fixed sentinel string instead of a real key — paired
 * with `isEncrypted() === false`, this signals dexie-storage to bypass
 * encryption entirely and store JSON as plaintext.
 *
 * Why this replaced the old EphemeralKeyProvider: the ephemeral provider
 * generated a random in-memory key on every page load. The key was lost on
 * tab close, so any data encrypted with it became permanently unrecoverable.
 * That was encryption theatre — visible cipher text with no actual confidentiality
 * guarantee, plus active data loss. Plaintext is at least honest about the
 * browser's same-origin protection. Users who need real at-rest encryption
 * either use the Electron desktop app (OS keychain) or opt in to
 * WebSessionPassphraseProvider via Settings → Security.
 */
export class PlaintextKeyProvider implements KeyProvider {
  readonly isHardwareBacked = false;
  readonly label = 'Plaintext (no encryption)';
  // Sentinel value used only when something accidentally hits the encryption
  // path; the discriminator below makes that not happen in practice.
  private static readonly SENTINEL = 'plaintext-sentinel-key-no-encryption-applied';

  async getKey(): Promise<string> {
    return PlaintextKeyProvider.SENTINEL;
  }

  isEncrypted(): boolean {
    return false;
  }
}

/**
 * Legacy in-memory key provider. Retained for backwards compatibility with
 * existing tests and any caller that explicitly opts in, but no longer the
 * web default — see PlaintextKeyProvider for the replacement rationale.
 * Generates a random key on first use and keeps it in memory; data encrypted
 * with this key is lost on tab close, which is why it was removed from the
 * default selection in `getKeyProvider()`.
 */
export class EphemeralKeyProvider implements KeyProvider {
  readonly isHardwareBacked = false;
  readonly label = 'Ephemeral (in-memory)';
  private cached: string | null = null;

  async getKey(): Promise<string> {
    if (this.cached === null) this.cached = generateLocalEncryptionKey();
    return this.cached;
  }

  isEncrypted(): boolean {
    return true;
  }
}

/**
 * Web provider that derives the key from a user-supplied passphrase via PBKDF2.
 * The key lives in memory only; on a fresh page load the user re-enters the
 * passphrase or proceeds without encryption (PlaintextKeyProvider).
 *
 * Salt is constant per app to keep re-derivation deterministic across sessions
 * without requiring users to remember a separate salt. Iteration count is 100k
 * (matches the existing encryption.ts settings).
 */
export class WebSessionPassphraseProvider implements KeyProvider {
  readonly isHardwareBacked = false;
  readonly label = 'Session passphrase';
  private static singletonKey: string | null = null;

  isEncrypted(): boolean {
    return true;
  }

  static reset(): void {
    WebSessionPassphraseProvider.singletonKey = null;
  }

  async setPassphrase(passphrase: string): Promise<void> {
    if (!passphrase) throw new Error('Passphrase must not be empty');
    const SALT = new TextEncoder().encode('restura/v1/passphrase');
    const passBytes = new TextEncoder().encode(passphrase);
    const material = await crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, [
      'deriveBits',
    ]);
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
      throw new Error('No passphrase set. Call setPassphrase first or use PlaintextKeyProvider.');
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

  isEncrypted(): boolean {
    return true;
  }

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
 * - Web (or Electron without store IPC) -> PlaintextKeyProvider as the default.
 *   The web client stores JSON un-encrypted in IndexedDB; users opt into
 *   encryption via Settings -> Security, which calls
 *   `setKeyProvider(new WebSessionPassphraseProvider(...))` after capturing
 *   a passphrase. See `docs/security.md` for the full policy.
 *
 * Once resolved, the provider is cached for the lifetime of the module.
 * setKeyProvider() lets callers swap in a different provider (used by the
 * web passphrase UI to upgrade Plaintext -> WebSessionPassphrase).
 *
 * TODO(web-passphrase-ui): wire a Settings -> Security UI that captures the
 * passphrase and calls `setKeyProvider(new WebSessionPassphraseProvider())`
 * followed by `setPassphrase(...)`. The provider plumbing is in place; only
 * the UI affordance is missing. Tracked in docs/security.md.
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
  // Web default: plaintext. Misleading "ephemeral encryption" mode was
  // removed because it lost the key (and the data) on every page load.
  activeProvider = new PlaintextKeyProvider();
  return activeProvider;
}

export function setKeyProvider(provider: KeyProvider): void {
  activeProvider = provider;
}

/** Test-only: clear the cached provider so the next getKeyProvider() re-resolves. */
export function __resetKeyProviderForTests(): void {
  activeProvider = null;
}
