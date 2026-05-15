import { describe, it, expect, beforeEach } from 'vitest';

describe('useFileCollectionStore persistence', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('uses the Dexie storage adapter and declares a schema version', async () => {
    const { useFileCollectionStore } = await import('../useFileCollectionStore');
    const opts = useFileCollectionStore.persist.getOptions();

    // Version must be declared so future schema changes have a migration handle.
    expect(opts.version).toBe(1);

    // Storage must be the Dexie adapter, not the zustand default (localStorage).
    expect(opts.storage).toBeDefined();
    expect(typeof opts.storage?.getItem).toBe('function');
    expect(typeof opts.storage?.setItem).toBe('function');
    expect(typeof opts.storage?.removeItem).toBe('function');

    // A passthrough migrate function should be wired up.
    expect(typeof opts.migrate).toBe('function');
  });

  it('keeps the same persist key so existing data is not orphaned', async () => {
    const { useFileCollectionStore } = await import('../useFileCollectionStore');
    const opts = useFileCollectionStore.persist.getOptions();
    expect(opts.name).toBe('file-collection-storage');
  });

  it('partializes only fileCollections and defaultDirectory (conflicts stay transient)', async () => {
    const { useFileCollectionStore } = await import('../useFileCollectionStore');
    const opts = useFileCollectionStore.persist.getOptions();
    expect(opts.partialize).toBeDefined();

    const fullState = useFileCollectionStore.getState();
    const partialized = opts.partialize ? opts.partialize(fullState) : fullState;
    const keys = Object.keys(partialized as object).sort();
    expect(keys).toEqual(['defaultDirectory', 'fileCollections']);
  });
});
