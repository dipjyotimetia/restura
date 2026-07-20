import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronAPI } from '../../../electron/types/electron-api';

type WindowWithElectron = {
  electron?: {
    collections?: {
      watchDirectory: ReturnType<typeof vi.fn>;
      loadFromDirectory?: ReturnType<typeof vi.fn>;
    };
  };
};

function installElectronCollections(collections: Partial<ElectronAPI['collections']>): void {
  (window as unknown as { electron: { collections: ElectronAPI['collections'] } }).electron = {
    collections: {
      removeFileChangedListener: vi.fn(),
      ...collections,
    } as ElectronAPI['collections'],
  };
}

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
    const { useFileCollectionStore, restoreFileCollectionWatchers } = await import(
      '../useFileCollectionStore'
    );
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
    const { useFileCollectionStore, loadCollectionFromDirectory } = await import(
      '../useFileCollectionStore'
    );
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

  it('loads complete OWS artifacts with a file collection and replaces stale workspace records', async () => {
    const { loadCollectionFromDirectory } = await import('../useFileCollectionStore');
    const { useCollectionStore } = await import('../useCollectionStore');
    const { useWorkflowStore } = await import('../useWorkflowStore');
    useCollectionStore.setState({ collections: [] });
    useWorkflowStore.setState({ workflows: [] });
    const list = vi.fn().mockResolvedValue({ ok: true, workflowIds: ['billing'] });
    const load = vi.fn().mockResolvedValue({
      ok: true,
      artifact: {
        workflow: {
          document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
          do: [{ initialize: { wait: { milliseconds: 0 } } }],
        },
        bindings: { version: 1, tasks: {} },
        layout: { version: 1, nodes: {} },
      },
    });
    (window as unknown as { electron: Partial<ElectronAPI> }).electron = {
      collections: {
        loadFromDirectory: vi.fn().mockResolvedValue({
          success: true,
          collection: { id: 'disk', name: 'Demo', items: [] },
        }),
        watchDirectory: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as ElectronAPI['collections'],
      owsWorkspace: { list, load } as unknown as ElectronAPI['owsWorkspace'],
    };

    await expect(loadCollectionFromDirectory('/tmp/ows-demo')).resolves.toMatchObject({
      success: true,
    });
    expect(useWorkflowStore.getState().workflows).toEqual([
      expect.objectContaining({ collectionId: 'disk', workspaceId: 'billing' }),
    ]);
    expect(list).toHaveBeenCalledWith('/tmp/ows-demo');
    expect(load).toHaveBeenCalledWith('/tmp/ows-demo', 'billing');
  });

  it('saves OWS companions through the registered workspace boundary and removes stale artifacts', async () => {
    const { useFileCollectionStore, syncFileCollection } = await import(
      '../useFileCollectionStore'
    );
    const { useCollectionStore } = await import('../useCollectionStore');
    const { useWorkflowStore } = await import('../useWorkflowStore');
    useCollectionStore.setState({ collections: [{ id: 'c1', name: 'Demo', items: [] }] });
    useWorkflowStore.setState({ workflows: [] });
    const workflow = useWorkflowStore.getState().createNewWorkflow('Billing', 'c1');
    useWorkflowStore.getState().addWorkflow({ ...workflow, workspaceId: 'billing' });
    useFileCollectionStore.getState().registerFileCollection('c1', '/tmp/ows-save');
    const save = vi.fn().mockResolvedValue({ ok: true });
    const list = vi.fn().mockResolvedValue({ ok: true, workflowIds: ['billing', 'stale'] });
    const remove = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { electron: Partial<ElectronAPI> }).electron = {
      collections: {
        saveToDirectory: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as ElectronAPI['collections'],
      owsWorkspace: { save, list, delete: remove } as unknown as ElectronAPI['owsWorkspace'],
    };

    await expect(syncFileCollection('c1')).resolves.toEqual({ success: true });
    expect(save).toHaveBeenCalledWith('/tmp/ows-save', 'billing', {
      workflow: workflow.document,
      bindings: workflow.bindings,
      layout: workflow.layout,
    });
    expect(remove).toHaveBeenCalledWith('/tmp/ows-save', 'stale');
  });

  it('preserves item, request, and row ids across disk reloads', async () => {
    const { reconcileCollectionIds } = await import('../useFileCollectionStore');
    type Ids = [string, string, string, string, string, string];
    const request = (ids: Ids) => ({
      id: ids[1],
      name: 'List users',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://example.test/users',
      headers: [{ id: ids[2], key: 'accept', value: 'application/json', enabled: true }],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' as const },
    });
    const collection = (ids: Ids) => ({
      id: ids[0],
      name: 'Demo',
      variables: [{ id: ids[3], key: 'baseUrl', value: 'example.test', enabled: true }],
      items: [
        {
          id: ids[4],
          name: 'Users',
          type: 'folder' as const,
          items: [
            { id: ids[5], name: 'List users', type: 'request' as const, request: request(ids) },
          ],
        },
      ],
    });

    const existing = collection([
      'collection-old',
      'request-old',
      'header-old',
      'var-old',
      'folder-old',
      'item-old',
    ]);
    const incoming = collection([
      'collection-new',
      'request-new',
      'header-new',
      'var-new',
      'folder-new',
      'item-new',
    ]);
    const reconciled = reconcileCollectionIds(existing, incoming);

    expect(reconciled.id).toBe('collection-old');
    expect(reconciled.variables?.[0]?.id).toBe('var-old');
    expect(reconciled.items[0]?.id).toBe('folder-old');
    expect(reconciled.items[0]?.items?.[0]?.id).toBe('item-old');
    expect(reconciled.items[0]?.items?.[0]?.request?.id).toBe('request-old');
    const reconciledRequest = reconciled.items[0]?.items?.[0]?.request;
    expect(reconciledRequest?.type === 'http' ? reconciledRequest.headers[0]?.id : undefined).toBe(
      'header-old'
    );
  });

  it('does not let inserted siblings or rows steal existing ids', async () => {
    const { reconcileCollectionIds } = await import('../useFileCollectionStore');
    const makeRequest = (itemId: string, requestId: string, headerId: string, name: string) => ({
      id: itemId,
      name,
      type: 'request' as const,
      request: {
        id: requestId,
        name,
        type: 'http' as const,
        method: 'GET' as const,
        url: `https://example.test/${name}`,
        headers: [{ id: headerId, key: 'accept', value: name, enabled: true }],
        params: [],
        body: { type: 'none' as const },
        auth: { type: 'none' as const },
      },
    });
    const existing = {
      id: 'old-collection',
      name: 'Demo',
      items: [makeRequest('old-item', 'old-request', 'old-header', 'existing')],
    };
    const inserted = makeRequest('new-item', 'new-request', 'new-header', 'inserted');
    const unchanged = makeRequest(
      'generated-item',
      'generated-request',
      'generated-header',
      'existing'
    );
    unchanged.request.headers.unshift({
      id: 'new-extra-header',
      key: 'x-new',
      value: '1',
      enabled: true,
    });
    const incoming = { id: 'generated-collection', name: 'Demo', items: [inserted, unchanged] };

    const reconciled = reconcileCollectionIds(existing, incoming);

    expect(reconciled.items[0]?.id).toBe('new-item');
    expect(reconciled.items[1]?.id).toBe('old-item');
    const unchangedRequest = reconciled.items[1]?.request;
    expect(unchangedRequest?.id).toBe('old-request');
    expect(unchangedRequest?.type === 'http' ? unchangedRequest.headers[1]?.id : undefined).toBe(
      'old-header'
    );
  });

  it('reconciles moved and renamed leftovers without positional id theft', async () => {
    const { reconcileCollectionIds } = await import('../useFileCollectionStore');
    const existing = {
      id: 'old-collection',
      name: 'Demo',
      items: [
        {
          id: 'old-folder',
          name: 'Folder',
          type: 'folder' as const,
          items: [{ id: 'old-child', name: 'Moved', type: 'request' as const }],
        },
        { id: 'old-rename', name: 'Before', type: 'request' as const },
      ],
    };
    const incoming = {
      id: 'new-collection',
      name: 'Demo',
      items: [
        { id: 'new-moved', name: 'Moved', type: 'request' as const },
        { id: 'new-rename', name: 'After', type: 'request' as const },
        { id: 'new-folder', name: 'Folder', type: 'folder' as const, items: [] },
      ],
    };

    const reconciled = reconcileCollectionIds(existing, incoming);
    expect(reconciled.items.map((item) => item.id)).toEqual([
      'old-child',
      'old-rename',
      'old-folder',
    ]);
  });

  it('leaves isWatching false when a directory can no longer be watched', async () => {
    const { useFileCollectionStore, restoreFileCollectionWatchers } = await import(
      '../useFileCollectionStore'
    );
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

describe('file collection operations', () => {
  beforeEach(async () => {
    delete (window as unknown as WindowWithElectron).electron;
    const { useFileCollectionStore, cleanupFileCollectionWatcher } = await import(
      '../useFileCollectionStore'
    );
    const { useCollectionStore } = await import('../useCollectionStore');
    cleanupFileCollectionWatcher();
    useFileCollectionStore.setState({ fileCollections: {}, conflicts: [], defaultDirectory: null });
    useCollectionStore.setState({ collections: [] });
  });

  afterEach(async () => {
    const { cleanupFileCollectionWatcher } = await import('../useFileCollectionStore');
    cleanupFileCollectionWatcher();
    delete (window as unknown as WindowWithElectron).electron;
  });

  it('covers file metadata, sync-state, and conflict actions', async () => {
    const { useFileCollectionStore } = await import('../useFileCollectionStore');
    const store = useFileCollectionStore.getState();
    store.registerFileCollection('c1', '/tmp/c1');
    store.updateSyncState('missing', 'error');
    store.updateSyncState('c1', 'modified', 'dirty');
    store.setWatching('missing', true);
    store.setWatching('c1', true);
    store.addConflict({
      collectionId: 'c1',
      itemId: 'i1',
      itemName: 'one',
      filePath: '/tmp/c1/one.yaml',
      localModified: 1,
      externalModified: 2,
    });
    store.addConflict({
      collectionId: 'c1',
      itemId: 'i1',
      itemName: 'replacement',
      filePath: '/tmp/c1/one.yaml',
      localModified: 1,
      externalModified: 3,
    });
    store.addConflict({
      collectionId: 'c1',
      itemId: 'i2',
      itemName: 'two',
      filePath: '/tmp/c1/two.yaml',
      localModified: 1,
      externalModified: 3,
    });
    store.removeConflict('c1', 'i1');
    store.clearConflicts('missing');
    store.setDefaultDirectory('/tmp/default');
    store.markAsSynced('missing');
    store.markAsSynced('c1');

    const current = useFileCollectionStore.getState();
    expect(current.isFileCollection('c1')).toBe(true);
    expect(current.getFileInfo('c1')).toMatchObject({ syncState: 'synced', isWatching: true });
    expect(current.conflicts).toHaveLength(1);
    expect(current.defaultDirectory).toBe('/tmp/default');

    current.removeConflict('c1');
    current.unregisterFileCollection('c1');
    expect(useFileCollectionStore.getState().isFileCollection('c1')).toBe(false);
  });

  it('handles unavailable Electron and missing collection branches', async () => {
    const {
      loadCollectionFromDirectory,
      saveCollectionToDirectory,
      syncFileCollection,
      selectCollectionDirectory,
      exportCollectionToFiles,
      openCollectionInExplorer,
      initFileCollectionWatcher,
    } = await import('../useFileCollectionStore');
    const collection = { id: 'c1', name: 'Demo', items: [] };

    await expect(loadCollectionFromDirectory('/tmp/demo')).resolves.toMatchObject({
      success: false,
    });
    await expect(saveCollectionToDirectory(collection, '/tmp/demo')).resolves.toMatchObject({
      success: false,
    });
    await expect(syncFileCollection('missing')).resolves.toMatchObject({ success: false });
    await expect(exportCollectionToFiles('missing', '/tmp/demo')).resolves.toMatchObject({
      success: false,
    });
    await expect(selectCollectionDirectory()).resolves.toBeNull();
    await expect(openCollectionInExplorer('missing')).resolves.toBeUndefined();
    expect(initFileCollectionWatcher()).toBeUndefined();
  });

  it('saves, syncs, exports, selects, and opens Electron file collections', async () => {
    const {
      useFileCollectionStore,
      saveCollectionToDirectory,
      syncFileCollection,
      selectCollectionDirectory,
      exportCollectionToFiles,
      openCollectionInExplorer,
    } = await import('../useFileCollectionStore');
    const { useCollectionStore } = await import('../useCollectionStore');
    const collection = { id: 'c1', name: 'Demo', items: [] };
    const saveToDirectory = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'disk full' })
      .mockResolvedValue({ success: true });
    const watchDirectory = vi.fn().mockResolvedValue({ success: true });
    const openInExplorer = vi.fn().mockResolvedValue(undefined);
    installElectronCollections({
      saveToDirectory,
      watchDirectory,
      openInExplorer,
      selectDirectory: vi
        .fn()
        .mockResolvedValueOnce({ canceled: true, filePaths: [] })
        .mockResolvedValue({ canceled: false, filePaths: ['/tmp/chosen'] }),
    });
    useCollectionStore.setState({ collections: [collection] });
    useFileCollectionStore.getState().registerFileCollection('c1', '/tmp/demo');

    await expect(saveCollectionToDirectory(collection, '/tmp/demo')).resolves.toMatchObject({
      success: false,
    });
    expect(useFileCollectionStore.getState().getFileInfo('c1')?.syncState).toBe('error');
    await expect(syncFileCollection('c1')).resolves.toMatchObject({ success: true });
    expect(useFileCollectionStore.getState().getFileInfo('c1')?.syncState).toBe('synced');
    await expect(selectCollectionDirectory()).resolves.toBeNull();
    await expect(selectCollectionDirectory()).resolves.toBe('/tmp/chosen');
    await openCollectionInExplorer('c1');
    expect(openInExplorer).toHaveBeenCalledWith('/tmp/demo');
    await expect(exportCollectionToFiles('c1', '/tmp/export')).resolves.toMatchObject({
      success: true,
    });
    expect(watchDirectory).toHaveBeenCalledWith('/tmp/export');

    useCollectionStore.setState({ collections: [] });
    await expect(syncFileCollection('c1')).resolves.toMatchObject({
      success: false,
      error: 'Collection not found',
    });
    await expect(exportCollectionToFiles('c1', '/tmp/export')).resolves.toMatchObject({
      success: false,
      error: 'Collection not found',
    });
  });

  it('marks local edits and external changes as conflicts through the watcher', async () => {
    const { useFileCollectionStore, initFileCollectionWatcher } = await import(
      '../useFileCollectionStore'
    );
    const { useCollectionStore } = await import('../useCollectionStore');
    const { useWorkflowStore } = await import('../useWorkflowStore');
    let onFileChanged:
      | ((event: {
          type: 'modified' | 'added' | 'deleted';
          filePath: string;
          directoryPath: string;
          lastModified?: number;
        }) => void)
      | undefined;
    installElectronCollections({
      onFileChanged: vi.fn((listener) => {
        onFileChanged = listener;
      }),
      removeFileChangedListener: vi.fn(),
    });
    useCollectionStore.setState({ collections: [{ id: 'c1', name: 'Demo', items: [] }] });
    useWorkflowStore.setState({ workflows: [] });
    useFileCollectionStore.getState().registerFileCollection('c1', '/tmp/demo');
    initFileCollectionWatcher();

    useCollectionStore.getState().updateCollection('c1', { name: 'Edited' });
    expect(useFileCollectionStore.getState().getFileInfo('c1')?.syncState).toBe('modified');
    onFileChanged?.({
      type: 'modified',
      filePath: '/tmp/demo/request.yaml',
      directoryPath: '/tmp/demo',
      lastModified: 123,
    });
    expect(useFileCollectionStore.getState().getFileInfo('c1')?.syncState).toBe('conflict');
    expect(useFileCollectionStore.getState().conflicts[0]).toMatchObject({
      itemName: 'request.yaml',
      externalModified: 123,
    });
    onFileChanged?.({ type: 'added', filePath: '/tmp/other.yaml', directoryPath: '/tmp/other' });
    expect(useFileCollectionStore.getState().conflicts).toHaveLength(1);

    useFileCollectionStore.getState().updateSyncState('c1', 'loading');
    onFileChanged?.({ type: 'modified', filePath: '/', directoryPath: '/tmp/demo' });
    expect(useFileCollectionStore.getState().conflicts.at(-1)?.itemName).toBe('Unknown');
  });

  it('treats workflow artifact edits as local file-project changes before an external reload', async () => {
    const { useFileCollectionStore, initFileCollectionWatcher } = await import(
      '../useFileCollectionStore'
    );
    const { useCollectionStore } = await import('../useCollectionStore');
    const { useWorkflowStore } = await import('../useWorkflowStore');
    let onFileChanged:
      | ((event: {
          type: 'modified' | 'added' | 'deleted';
          filePath: string;
          directoryPath: string;
          lastModified?: number;
        }) => void)
      | undefined;
    installElectronCollections({
      onFileChanged: vi.fn((listener) => {
        onFileChanged = listener;
      }),
      removeFileChangedListener: vi.fn(),
    });
    useCollectionStore.setState({ collections: [{ id: 'c1', name: 'Demo', items: [] }] });
    useWorkflowStore.setState({ workflows: [] });
    useFileCollectionStore.getState().registerFileCollection('c1', '/tmp/demo');
    initFileCollectionWatcher();

    useWorkflowStore.getState().addWorkflow({
      id: 'workflow-1',
      collectionId: 'c1',
      workspaceId: 'workflow-1',
      document: {
        document: { dsl: '1.0.3', namespace: 'restura', name: 'workflow', version: '1.0.0' },
        do: [{ initialize: { wait: { milliseconds: 0 } } }],
      },
      bindings: { version: 1, tasks: {} },
      layout: { version: 1, nodes: {} },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(useFileCollectionStore.getState().getFileInfo('c1')?.syncState).toBe('modified');

    onFileChanged?.({
      type: 'modified',
      filePath: '/tmp/demo/workflows/workflow-1/workflow.ows.json',
      directoryPath: '/tmp/demo',
      lastModified: 456,
    });
    expect(useFileCollectionStore.getState().getFileInfo('c1')?.syncState).toBe('conflict');
    expect(useFileCollectionStore.getState().conflicts.at(-1)).toMatchObject({
      itemName: 'workflow.ows.json',
      externalModified: 456,
    });
  });

  it('reloads clean external changes and surfaces load failures', async () => {
    const { useFileCollectionStore, initFileCollectionWatcher } = await import(
      '../useFileCollectionStore'
    );
    const { useCollectionStore } = await import('../useCollectionStore');
    let onFileChanged:
      | ((event: {
          type: 'modified' | 'added' | 'deleted';
          filePath: string;
          directoryPath: string;
          lastModified?: number;
        }) => void)
      | undefined;
    const loadFromDirectory = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        collection: { id: 'disk-1', name: 'Reloaded', items: [] },
      })
      .mockResolvedValueOnce({ success: false, error: 'invalid disk data' })
      .mockRejectedValueOnce(new Error('read failed'));
    installElectronCollections({
      loadFromDirectory,
      watchDirectory: vi.fn().mockResolvedValue({ success: true }),
      onFileChanged: vi.fn((listener) => {
        onFileChanged = listener;
      }),
    });
    useCollectionStore.setState({ collections: [{ id: 'c1', name: 'Demo', items: [] }] });
    useFileCollectionStore.getState().registerFileCollection('c1', '/tmp/demo');
    initFileCollectionWatcher();

    onFileChanged?.({ type: 'modified', filePath: '/tmp/demo/a.yaml', directoryPath: '/tmp/demo' });
    await vi.waitFor(() =>
      expect(useCollectionStore.getState().collections[0]?.name).toBe('Reloaded')
    );

    onFileChanged?.({ type: 'modified', filePath: '/tmp/demo/b.yaml', directoryPath: '/tmp/demo' });
    await vi.waitFor(() =>
      expect(useFileCollectionStore.getState().getFileInfo('c1')).toMatchObject({
        syncState: 'error',
        error: 'invalid disk data',
      })
    );

    useFileCollectionStore.getState().markAsSynced('c1');
    onFileChanged?.({ type: 'modified', filePath: '/tmp/demo/c.yaml', directoryPath: '/tmp/demo' });
    await vi.waitFor(() =>
      expect(useFileCollectionStore.getState().getFileInfo('c1')).toMatchObject({
        syncState: 'error',
        error: 'read failed',
      })
    );
  });

  it('coalesces an external change burst into one follow-up reload', async () => {
    const { useFileCollectionStore, initFileCollectionWatcher } = await import(
      '../useFileCollectionStore'
    );
    const { useCollectionStore } = await import('../useCollectionStore');
    let onFileChanged:
      | ((event: {
          type: 'modified' | 'added' | 'deleted';
          filePath: string;
          directoryPath: string;
        }) => void)
      | undefined;
    let resolveFirst: ((value: unknown) => void) | undefined;
    const loadFromDirectory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue({
        success: true,
        collection: { id: 'disk-2', name: 'After burst', items: [] },
      });
    installElectronCollections({
      loadFromDirectory,
      watchDirectory: vi.fn().mockResolvedValue({ success: false }),
      onFileChanged: vi.fn((listener) => {
        onFileChanged = listener;
      }),
    });
    useCollectionStore.setState({ collections: [{ id: 'c1', name: 'Demo', items: [] }] });
    useFileCollectionStore.getState().registerFileCollection('c1', '/tmp/demo');
    initFileCollectionWatcher();

    onFileChanged?.({ type: 'modified', filePath: '/tmp/demo/a.yaml', directoryPath: '/tmp/demo' });
    onFileChanged?.({ type: 'modified', filePath: '/tmp/demo/b.yaml', directoryPath: '/tmp/demo' });
    expect(loadFromDirectory).toHaveBeenCalledTimes(1);
    resolveFirst?.({
      success: true,
      collection: { id: 'disk-1', name: 'First reload', items: [] },
    });

    await vi.waitFor(() => expect(loadFromDirectory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(useCollectionStore.getState().collections[0]?.name).toBe('After burst')
    );
    expect(useFileCollectionStore.getState().getFileInfo('c1')?.isWatching).toBe(false);
  });
});
