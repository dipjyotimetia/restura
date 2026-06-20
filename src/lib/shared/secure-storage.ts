import { isElectron } from './platform';

const SENSITIVE_KEY_PATTERNS = [
  /auth/,
  /token/,
  /password/,
  // A TLS/key passphrase is secret material but does not contain "password";
  // without this, kafka:*/mqtt:* `tls-passphrase` keys fell through to plaintext
  // localStorage on desktop instead of the encrypted electron-store.
  /passphrase/,
  /apiKey/,
  /secret/,
  /credential/,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** Drop any plaintext copy of a key so a sensitive value never lingers there. */
function purgePlaintext(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// In-memory cache for sensitive values (updated on set, lazily populated on get)
const sensitiveCache = new Map<string, string>();

export const secureStorage = {
  get: (key: string): string | null => {
    if (isElectron() && isSensitiveKey(key)) {
      if (sensitiveCache.has(key)) {
        return sensitiveCache.get(key) ?? null;
      }
      // One-time migration: a value written before its key counted as sensitive
      // (e.g. tls-passphrase keys predating the /passphrase/ rule) lingers in
      // plaintext localStorage. Move it into the encrypted store and purge the
      // plaintext copy so the secret stops persisting unencrypted — and so the
      // user doesn't silently lose it now that reads target the secure store.
      let stale: string | null = null;
      try {
        stale = typeof window === 'undefined' ? null : localStorage.getItem(key);
      } catch {
        stale = null;
      }
      if (stale !== null) {
        sensitiveCache.set(key, stale);
        window.electron?.store.set(key, stale);
        purgePlaintext(key);
        return stale;
      }
      // Trigger async hydration — result available on next read
      window.electron?.store
        .get(key)
        .then((value) => {
          if (value !== undefined && value !== null) {
            sensitiveCache.set(key, value);
          }
        })
        .catch(() => {
          // ignore — store may not have this key
        });
      return null;
    }
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  set: (key: string, value: string): void => {
    if (isElectron() && isSensitiveKey(key)) {
      sensitiveCache.set(key, value);
      // Fire-and-forget IPC write to electron-store
      window.electron?.store.set(key, value);
      // Never leave a plaintext copy behind (e.g. a value written before this
      // key counted as sensitive).
      purgePlaintext(key);
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },

  remove: (key: string): void => {
    if (isElectron() && isSensitiveKey(key)) {
      sensitiveCache.delete(key);
      window.electron?.store.delete(key);
      // Symmetric with set/get: also drop any stale plaintext copy, otherwise a
      // later get() would "migrate" it back and resurrect a removed secret.
      purgePlaintext(key);
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },

  clear: (): void => {
    if (isElectron()) {
      sensitiveCache.clear();
      window.electron?.store.clear();
      return; // Don't fall through to localStorage.clear() in Electron
    }
    if (typeof window === 'undefined') return;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  },
};
