import { isElectron } from './platform';

const SENSITIVE_KEY_PATTERNS = [
  /auth/,
  /token/,
  /password/,
  /apiKey/,
  /secret/,
  /credential/,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

// In-memory cache for sensitive values (updated on set, lazily populated on get)
const sensitiveCache = new Map<string, string>();

export const secureStorage = {
  get: (key: string): string | null => {
    if (isElectron() && isSensitiveKey(key)) {
      if (sensitiveCache.has(key)) {
        return sensitiveCache.get(key) ?? null;
      }
      // Trigger async hydration — result available on next read
      window.electron?.store.get(key).then((value) => {
        if (value !== undefined && value !== null) {
          sensitiveCache.set(key, value);
        }
      }).catch(() => {
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
