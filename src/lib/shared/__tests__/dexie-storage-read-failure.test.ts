import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/lib/shared/dexie-storage');

// A transient IndexedDB read error is not "no data". If getItem reports it as
// null the store hydrates defaults and zustand's next setState persists them,
// overwriting the user's real row. The adapter must refuse to write a name
// whose last read failed, until a read of it succeeds.
describe('dexie storage after a failed read', () => {
  beforeEach(async () => {
    const { setKeyProvider, PlaintextKeyProvider } = await import('../keyProvider');
    setKeyProvider(new PlaintextKeyProvider());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    const { __resetKeyProviderForTests } = await import('../keyProvider');
    __resetKeyProviderForTests();
    vi.restoreAllMocks();
  });

  it('does not overwrite the persisted row with defaults when the read errored', async () => {
    const { createDexieStorage } = await import('../dexie-storage');
    const { db } = await import('../database');
    const storage = createDexieStorage<{ a: number }>({ tableName: 'settings', encrypt: false });

    await storage.setItem('read-fail', { state: { a: 42 }, version: 0 });

    const getSpy = vi.spyOn(db.settings, 'get').mockRejectedValueOnce(new Error('transient idb'));
    await expect(storage.getItem('read-fail')).resolves.toBeNull();

    // persist writes the hydrated defaults on the next state change
    await storage.setItem('read-fail', { state: { a: 0 }, version: 0 });
    getSpy.mockRestore();

    const row = await db.settings.get('read-fail');
    expect(JSON.parse(row?.encryptedData ?? '{}')).toEqual({ state: { a: 42 }, version: 0 });
  });

  it('resumes writing once a read succeeds', async () => {
    const { createDexieStorage } = await import('../dexie-storage');
    const { db } = await import('../database');
    const storage = createDexieStorage<{ a: number }>({ tableName: 'settings', encrypt: false });

    await storage.setItem('read-recover', { state: { a: 1 }, version: 0 });
    vi.spyOn(db.settings, 'get').mockRejectedValueOnce(new Error('transient idb'));
    await storage.getItem('read-recover');
    await expect(storage.getItem('read-recover')).resolves.toEqual({
      state: { a: 1 },
      version: 0,
    });

    await storage.setItem('read-recover', { state: { a: 2 }, version: 0 });
    const row = await db.settings.get('read-recover');
    expect(JSON.parse(row?.encryptedData ?? '{}')).toEqual({ state: { a: 2 }, version: 0 });
  });

  it('still writes a name that was simply missing', async () => {
    const { createDexieStorage } = await import('../dexie-storage');
    const { db } = await import('../database');
    const storage = createDexieStorage<{ a: number }>({ tableName: 'settings', encrypt: false });

    await expect(storage.getItem('never-written')).resolves.toBeNull();
    await storage.setItem('never-written', { state: { a: 7 }, version: 0 });
    const row = await db.settings.get('never-written');
    expect(JSON.parse(row?.encryptedData ?? '{}')).toEqual({ state: { a: 7 }, version: 0 });
  });
});
