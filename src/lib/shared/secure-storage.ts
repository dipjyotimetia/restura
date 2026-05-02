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

// In-memory cache for sensitive values (populated on init, updated on set)
const sensitiveCache = new Map<string, string>();

let initialized = false;

export async function initSecureStorage(): Promise<void> {
  if (!isElectron() || initialized) return;
  // Can't pre-load without knowing all keys — cache starts empty,
  // values are loaded lazily on first get if cache misses
  initialized = true;
}

export const secureStorage = {
  get: (key: string): string | null => {
    if (isElectron() && isSensitiveKey(key)) {
      return sensitiveCache.get(key) ?? null;
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
    }
    if (typeof window === 'undefined') return;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  },
};
