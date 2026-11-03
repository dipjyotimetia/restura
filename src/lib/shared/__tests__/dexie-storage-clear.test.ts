import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/lib/shared/dexie-storage');

describe('clearDexieStorage', () => {
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('clears every desktop secret store as part of Clear all data', async () => {
    const { clearDexieStorage } = await import('../dexie-storage');
    const storeClear = vi.fn(async () => undefined);
    const secretsClear = vi.fn(async () => ({ ok: true as const }));
    const vaultClear = vi.fn(async () => ({ ok: true as const }));
    Object.defineProperty(window, 'electron', {
      value: {
        isElectron: true,
        store: { clear: storeClear },
        secrets: { clear: secretsClear },
        vault: { clear: vaultClear },
      },
      configurable: true,
    });
    expect(window.electron?.isElectron).toBe(true);

    await clearDexieStorage();

    expect(storeClear).toHaveBeenCalledOnce();
    expect(secretsClear).toHaveBeenCalledOnce();
    expect(vaultClear).toHaveBeenCalledOnce();
  });

  it('drops the key provider cache so post-clear writes do not use the deleted key', async () => {
    const { clearDexieStorage } = await import('../dexie-storage');
    const { ElectronSafeStorageKeyProvider, setKeyProvider, __resetKeyProviderForTests } =
      await import('../keyProvider');
    const provider = new ElectronSafeStorageKeyProvider({
      get: vi.fn(async () => 'k'),
      set: vi.fn(async () => undefined),
      has: vi.fn(async () => true),
    });
    const resetCache = vi.spyOn(provider, 'resetCache');
    setKeyProvider(provider);
    try {
      await clearDexieStorage();
      expect(resetCache).toHaveBeenCalledOnce();
    } finally {
      __resetKeyProviderForTests();
    }
  });
});
