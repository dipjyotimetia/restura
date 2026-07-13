import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type WindowWithElectron = {
  electron?: {
    collections?: {
      watchDirectory: ReturnType<typeof vi.fn>;
      loadFromDirectory?: ReturnType<typeof vi.fn>;
    };
  };
};

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

describe('restoreFileCollectionWatchers', () => {
  beforeEach(async () => {
    // Clean slate: the store is a module singleton shared across tests.
    const { useFileCollectionStore } = await import('../useFileCollectionStore');
    useFileCollectionStore.setState({ fileCollections: {}, conflicts: [] });
  });

  afterEach(() => {
    delete (window as unknown as WindowWithElectron).electron;
  });

  it('reloads every persisted collection from disk and restores its watcher', async () => {
    const { useFileCollectionStore, restoreFileCollectionWatchers } =
      await import('../useFileCollectionStore');
    const watchDirectory = vi.fn().mockResolvedValue({ success: true });
    const loadFromDirectory = vi.fn((directoryPath: string) =>
      Promise.resolve({
        success: true,
        collection: { id: `disk-${directoryPath}`, name: directoryPath, items: [] },
      })
    );
    (window as unknown as WindowWithElectron).electron = {
      collections: { watchDirectory, loadFromDirectory },
    };

    const store = useFileCollectionStore.getState();
    store.registerFileCollection('col-a', '/tmp/a');
    store.registerFileCollection('col-b', '/tmp/b');
    // registerFileCollection seeds isWatching: false — the post-restart state.
    expect(useFileCollectionStore.getState().fileCollections['col-a']?.isWatching).toBe(false);

    await restoreFileCollectionWatchers();

    expect(loadFromDirectory).toHaveBeenCalledTimes(2);
    expect(loadFromDirectory).toHaveBeenCalledWith('/tmp/a');
    expect(loadFromDirectory).toHaveBeenCalledWith('/tmp/b');
    expect(watchDirectory).toHaveBeenCalledTimes(2);
    expect(watchDirectory).toHaveBeenCalledWith('/tmp/a');
    expect(watchDirectory).toHaveBeenCalledWith('/tmp/b');
    const after = useFileCollectionStore.getState().fileCollections;
    expect(after['col-a']?.isWatching).toBe(true);
    expect(after['col-b']?.isWatching).toBe(true);
  });

  it('reloading a directory replaces the open collection instead of duplicating it', async () => {
    const { useFileCollectionStore, loadCollectionFromDirectory } =
      await import('../useFileCollectionStore');
    const { useCollectionStore } = await import('../useCollectionStore');
    useCollectionStore.setState({ collections: [] });

    // The main process mints a NEW id on each load — simulate that to prove the
    // upsert keys on directory identity, not the (unstable) id.
    const loadFromDirectory = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        collection: { id: 'gen-1', name: 'Demo', items: [] },
      })
      .mockResolvedValueOnce({
        success: true,
        collection: { id: 'gen-2', name: 'Demo (branch)', items: [] },
      });
    const watchDirectory = vi.fn().mockResolvedValue({ success: true });
    (window as unknown as WindowWithElectron).electron = {
      collections: { watchDirectory, loadFromDirectory },
    };

    await loadCollectionFromDirectory('/tmp/demo');
    await loadCollectionFromDirectory('/tmp/demo'); // e.g. post-checkout reload

    const collections = useCollectionStore.getState().collections;
    expect(collections).toHaveLength(1);
    expect(collections[0]?.name).toBe('Demo (branch)'); // replaced, not appended
    // The fileCollections registry stays single-entry (no orphaned id).
    const fileCollections = useFileCollectionStore.getState().fileCollections;
    const forDir = Object.values(fileCollections).filter((i) => i.directoryPath === '/tmp/demo');
    expect(forDir).toHaveLength(1);
  });

  it('leaves isWatching false when a directory can no longer be watched', async () => {
    const { useFileCollectionStore, restoreFileCollectionWatchers } =
      await import('../useFileCollectionStore');
    const watchDirectory = vi.fn();
    const loadFromDirectory = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'gone' })
      .mockRejectedValueOnce(new Error('boom'));
    (window as unknown as WindowWithElectron).electron = {
      collections: { watchDirectory, loadFromDirectory },
    };

    const store = useFileCollectionStore.getState();
    store.registerFileCollection('col-a', '/tmp/a');
    store.registerFileCollection('col-b', '/tmp/b');

    await restoreFileCollectionWatchers();

    const after = useFileCollectionStore.getState().fileCollections;
    expect(after['col-a']?.isWatching).toBe(false);
    expect(after['col-b']?.isWatching).toBe(false);
  });
});
