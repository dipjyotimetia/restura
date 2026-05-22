// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory backing for the fake electron-store. Module-level so the mock
// factory below can capture it without circular dependencies.
const inMemoryStore = new Map<string, unknown>();

// The source uses `require('electron-store').default`. Vitest's vi.mock can
// intercept CJS require if hoisted, and the factory must return an object
// shaped like the real module: a default export that's a class.
vi.mock('electron-store', () => {
  class FakeStore {
    constructor() { /* options are ignored in tests */ }
    get(key: string) { return inMemoryStore.get(key); }
    set(key: string, value: unknown) { inMemoryStore.set(key, value); }
    delete(key: string) { inMemoryStore.delete(key); }
    clear() { inMemoryStore.clear(); }
    has(key: string) { return inMemoryStore.has(key); }
    get store() { return Object.fromEntries(inMemoryStore.entries()); }
  }
  return { default: FakeStore };
});

// Mock encrypted-key so the store doesn't talk to safeStorage at import
// time. The key value is irrelevant — the fake store ignores it.
vi.mock('../encrypted-key', () => ({
  getOrCreateEncryptedKey: vi.fn(() => 'test-encryption-key'),
  getKeyStoreStatus: vi.fn(() => ({ mode: 'safeStorage', plaintextStores: [] })),
}));

// Note: electron is mocked in __tests__/setup.ts (loaded for every test).
// No additional mock needed here.

import {
  unwrapSecretValueMain,
} from '../secret-handle-store';

describe('secret-handle-store', () => {
  beforeEach(() => {
    inMemoryStore.clear();
  });

  describe('unwrapSecretValueMain (pure-function surface)', () => {
    it('passes plain strings through (legacy auth compatibility)', () => {
      expect(unwrapSecretValueMain('plain')).toBe('plain');
    });

    it('returns the value of an inline SecretRef', () => {
      expect(unwrapSecretValueMain({ kind: 'inline', value: 'inline-val' })).toBe(
        'inline-val'
      );
    });

    it('returns undefined for null / undefined / wrong shape', () => {
      expect(unwrapSecretValueMain(undefined)).toBeUndefined();
      expect(unwrapSecretValueMain(null)).toBeUndefined();
      expect(unwrapSecretValueMain({ kind: 'unknown' })).toBeUndefined();
      expect(unwrapSecretValueMain({ kind: 'handle' })).toBeUndefined(); // missing id
      expect(unwrapSecretValueMain(42)).toBeUndefined();
    });

    it('returns empty string for empty inline value (consistent with renderer unwrap)', () => {
      expect(unwrapSecretValueMain({ kind: 'inline', value: '' })).toBe('');
    });
  });

  describe('IPC surface excludes resolve (defense-in-depth invariant)', () => {
    // The single most important security property of this module: the
    // renderer must never be able to read plaintext back out. Verify the
    // module source does NOT include `secret:resolve` as an IPC registration.
    it('does not register any `secret:resolve*` IPC channel', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const source = readFileSync(
        join(__dirname, '..', 'secret-handle-store.ts'),
        'utf8'
      );
      // Allow mentions in comments (the file explains *why* it's NOT exposed);
      // forbid any IPC registration whose channel name BEGINS with
      // 'secret:resolve' — catches typos and variants like
      // 'secret:resolveV2', 'secret:resolve-internal', etc.
      expect(source).not.toMatch(/ipcMain\.(handle|on)\(\s*['"]secret:resolve/i);
    });

    it('does not expose resolveSecretHandle through the preload bridge', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const preload = readFileSync(
        join(__dirname, '..', 'preload.ts'),
        'utf8'
      );
      // The preload should NOT mention resolveSecretHandle. If it does, the
      // renderer can read plaintext, defeating the entire pattern.
      expect(preload).not.toMatch(/resolveSecretHandle/);
      // Same broadened pattern as above.
      expect(preload).not.toMatch(/['"]secret:resolve/i);
    });
  });
});
