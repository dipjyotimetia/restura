// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory backing injected through the module's test seam
// (__setSecretStoreForTests). vi.mock('electron-store') can NOT be used here:
// the source loads the store via a lazy bare `require('electron-store')`,
// which vitest's ESM-level mocking does not intercept — the real module would
// load and throw under vitest.
const inMemoryStore = new Map<string, unknown>();

const fakeStore = {
  get: (key: string) => inMemoryStore.get(key) as never,
  set: (key: string, value: unknown) => void inMemoryStore.set(key, value as never),
  delete: (key: string) => void inMemoryStore.delete(key),
  clear: () => inMemoryStore.clear(),
  has: (key: string) => inMemoryStore.has(key),
  get store() {
    return Object.fromEntries(inMemoryStore.entries()) as never;
  },
};

// Mock encrypted-key so the store doesn't talk to safeStorage at import
// time. The key value is irrelevant — the fake store ignores it.
vi.mock('../security/encrypted-key', () => ({
  getOrCreateEncryptedKey: vi.fn(() => 'test-encryption-key'),
  getKeyStoreStatus: vi.fn(() => ({ mode: 'safeStorage', plaintextStores: [] })),
}));

// Mock electron so the IPC policy-stack tests below can register handlers
// against a fake ipcMain and drive them with synthetic events. (The real
// `electron` package's main export is just the executable path — unusable
// under vitest.)
const mockIpcHandle = vi.hoisted(() => vi.fn());
const mockIpcRemoveHandler = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  ipcMain: { handle: mockIpcHandle, removeHandler: mockIpcRemoveHandler },
}));

import {
  unwrapSecretValueMain,
  __setSecretStoreForTests,
  registerSecretHandleIPC,
  secretRateLimiter,
} from '../security/secret-handle-store';

describe('secret-handle-store', () => {
  beforeEach(() => {
    inMemoryStore.clear();
    __setSecretStoreForTests(fakeStore);
  });

  describe('unwrapSecretValueMain (pure-function surface)', () => {
    it('passes plain strings through (legacy auth compatibility)', () => {
      expect(unwrapSecretValueMain('plain')).toBe('plain');
    });

    it('returns the value of an inline SecretRef', () => {
      expect(unwrapSecretValueMain({ kind: 'inline', value: 'inline-val' })).toBe('inline-val');
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
        join(__dirname, '..', 'security', 'secret-handle-store.ts'),
        'utf8'
      );
      // Allow mentions in comments (the file explains *why* it's NOT exposed);
      // forbid any IPC registration whose channel name BEGINS with
      // 'secret:resolve' — catches typos and variants like
      // 'secret:resolveV2', 'secret:resolve-internal', etc. Registration goes
      // through handleSecretChannel (which wraps ipcMain.handle), so guard
      // both spellings plus a hypothetical IPC.secret.resolve constant.
      expect(source).not.toMatch(/ipcMain\.(handle|on)\(\s*['"]secret:resolve/i);
      expect(source).not.toMatch(/handleSecretChannel\(\s*['"]secret:resolve/i);
      expect(source).not.toMatch(/IPC\.secret\.resolve/);
    });

    it('does not expose resolveSecretHandle through the preload bridge', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const preload = readFileSync(join(__dirname, '..', 'preload.ts'), 'utf8');
      // The preload should NOT mention resolveSecretHandle. If it does, the
      // renderer can read plaintext, defeating the entire pattern.
      expect(preload).not.toMatch(/resolveSecretHandle/);
      // Same broadened pattern as above.
      expect(preload).not.toMatch(/['"]secret:resolve/i);
    });
  });

  describe('IPC policy stack (rate limit → trusted sender → validation)', () => {
    const trustedEvent = (senderId: number) => ({
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
      sender: { id: senderId },
    });

    type IpcHandler = (event: unknown, payload?: unknown) => Promise<Record<string, unknown>>;

    let handlers: Map<string, IpcHandler>;

    beforeEach(() => {
      mockIpcHandle.mockClear();
      registerSecretHandleIPC();
      handlers = new Map(
        mockIpcHandle.mock.calls.map(([channel, fn]) => [channel as string, fn as IpcHandler])
      );
    });

    it('registers all four channels and no others', () => {
      expect([...handlers.keys()].sort()).toEqual([
        'secret:delete',
        'secret:describe',
        'secret:list',
        'secret:store',
      ]);
    });

    it('store → describe → list → delete round-trip preserves the renderer contract', async () => {
      const event = trustedEvent(101);
      const stored = await handlers.get('secret:store')!(event, {
        value: 'hunter2',
        label: 'test-label',
      });
      expect(stored).toEqual({ ok: true, id: expect.any(String) });

      const described = await handlers.get('secret:describe')!(event, { id: stored.id });
      expect(described).toEqual({
        ok: true,
        handle: { label: 'test-label', createdAt: expect.any(Number) },
      });
      // Plaintext never appears in describe/list output.
      expect(JSON.stringify(described)).not.toContain('hunter2');

      const listed = await handlers.get('secret:list')!(event); // zero-arg invoke
      expect(listed).toEqual({
        ok: true,
        handles: [{ id: stored.id, label: 'test-label', createdAt: expect.any(Number) }],
      });

      expect(await handlers.get('secret:delete')!(event, { id: stored.id })).toEqual({ ok: true });
      expect(await handlers.get('secret:list')!(event)).toEqual({ ok: true, handles: [] });
    });

    it('returns { ok: false, error } on invalid payload instead of rejecting', async () => {
      const event = trustedEvent(102);
      const result = await handlers.get('secret:store')!(event, { value: '' }); // min(1) violation
      expect(result.ok).toBe(false);
      expect(result.error).toEqual(expect.any(String));

      const badId = await handlers.get('secret:delete')!(event, { id: 'not-a-uuid' });
      expect(badId.ok).toBe(false);
    });

    it('rejects an untrusted sender frame', async () => {
      const event = {
        senderFrame: { url: 'https://attacker.example/', parent: null },
        sender: { id: 103 },
      };
      await expect(handlers.get('secret:store')!(event, { value: 'x' })).rejects.toThrow(
        /untrusted frame/
      );
    });

    it('rejects a trusted URL loaded in a subframe', async () => {
      const event = {
        senderFrame: { url: 'file:///app/dist/web/index.html', parent: {} },
        sender: { id: 104 },
      };
      await expect(handlers.get('secret:list')!(event)).rejects.toThrow(/untrusted frame/);
    });

    it('enforces the keyed rate limit per webContents', async () => {
      const senderId = 105;
      try {
        const event = trustedEvent(senderId);
        // Exhaust the 600/min budget directly on the limiter, then verify the
        // next IPC call through the handler is rejected.
        while (secretRateLimiter.check(senderId)) {
          /* drain */
        }
        await expect(handlers.get('secret:list')!(event)).rejects.toThrow(/Rate limit exceeded/);
        // A different webContents still has its own budget.
        expect(await handlers.get('secret:list')!(trustedEvent(106))).toEqual({
          ok: true,
          handles: [],
        });
      } finally {
        secretRateLimiter.dispose(senderId);
      }
    });
  });
});
