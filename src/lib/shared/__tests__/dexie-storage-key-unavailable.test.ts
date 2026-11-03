import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/lib/shared/dexie-storage');

// The stored encryption key exists but cannot be read (main's store.get
// swallowed an error): the provider fails closed. The storage adapter must say
// so instead of silently hydrating empty and dropping every write.
describe('dexie storage when the encryption key is unreadable', () => {
  const events: Event[] = [];
  const listener = (event: Event) => events.push(event);

  beforeEach(async () => {
    events.length = 0;
    window.addEventListener('restura:storage-key-unavailable', listener);
    const { ElectronSafeStorageKeyProvider, setKeyProvider } = await import('../keyProvider');
    setKeyProvider(
      new ElectronSafeStorageKeyProvider({
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        has: vi.fn(async () => true),
      })
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    window.removeEventListener('restura:storage-key-unavailable', listener);
    const { __resetKeyProviderForTests } = await import('../keyProvider');
    __resetKeyProviderForTests();
    vi.restoreAllMocks();
  });

  it('raises restura:storage-key-unavailable when a write cannot be encrypted', async () => {
    const { createDexieStorage } = await import('../dexie-storage');
    const storage = createDexieStorage<{ a: number }>({ tableName: 'settings' });

    await storage.setItem('key-unavailable-write', { state: { a: 1 }, version: 0 });

    expect(events).toHaveLength(1);
    // Latched for a notice that mounts after module-load hydration.
    const { isStorageKeyUnavailable } = await import('../dexie-storage');
    expect(isStorageKeyUnavailable()).toBe(true);
  });

  it('raises restura:storage-key-unavailable when an encrypted row cannot be read', async () => {
    const { createDexieStorage } = await import('../dexie-storage');
    const { db } = await import('../database');
    await db.settings.put({
      id: 'key-unavailable-read',
      name: 'key-unavailable-read',
      updatedAt: Date.now(),
      encryptedData: 'ENC:opaque',
    } as never);
    const storage = createDexieStorage<{ a: number }>({ tableName: 'settings' });

    await expect(storage.getItem('key-unavailable-read')).resolves.toBeNull();

    expect(events).toHaveLength(1);
    // The ciphertext is left in place (not quarantined) for when the key is readable again.
    const row = await db.settings.get('key-unavailable-read');
    expect(row?.encryptedData).toBe('ENC:opaque');
  });
});
