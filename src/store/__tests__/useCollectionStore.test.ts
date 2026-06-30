import { describe, it, expect, beforeEach } from 'vitest';
import { useCollectionStore } from '../useCollectionStore';
import { internalToOC } from '@/lib/opencollection/from-internal';
import type { Collection, CollectionItem } from '@/types';

describe('useCollectionStore', () => {
  beforeEach(() => {
    useCollectionStore.setState({
      collections: [],
      activeCollectionId: null,
    });
    localStorage.clear();
  });

  describe('initial state', () => {
    it('should start with empty collections', () => {
      const state = useCollectionStore.getState();
      expect(state.collections).toEqual([]);
      expect(state.activeCollectionId).toBeNull();
    });
  });

  describe('createNewCollection', () => {
    it('should create collection with given name', () => {
      const { createNewCollection } = useCollectionStore.getState();
      const collection = createNewCollection('API Tests');

      expect(collection.name).toBe('API Tests');
      expect(collection.id).toBeDefined();
      expect(collection.items).toEqual([]);
    });
  });

  describe('addCollection', () => {
    it('should add collection to list', () => {
      const { createNewCollection, addCollection } = useCollectionStore.getState();
      const collection = createNewCollection('Test Collection');
      addCollection(collection);

      const state = useCollectionStore.getState();
      expect(state.collections).toHaveLength(1);
      expect(state.collections[0]).toEqual(collection);
    });
  });

  describe('updateCollectionItem defeats a stale _oc bag on edit (audit Fix 7)', () => {
    it('re-exports a folder-nested request with the edit, not the stale imported bag', () => {
      const { addCollection, updateCollectionItem } = useCollectionStore.getState();

      // Simulate an imported OpenCollection: the request and its parent folder
      // both carry verbatim `_oc` passthrough bags (method GET).
      const reqOc = {
        info: { type: 'http', name: 'Get Thing' },
        http: { method: 'GET', url: 'https://api.example.com/thing' },
      };
      const reqItem = {
        id: 'req-1',
        type: 'request' as const,
        name: 'Get Thing',
        _oc: reqOc,
        request: {
          id: 'req-1',
          name: 'Get Thing',
          type: 'http' as const,
          method: 'GET' as const,
          url: 'https://api.example.com/thing',
          headers: [],
          params: [],
          body: { type: 'none' as const },
          auth: { type: 'none' as const },
        },
      };
      const folderItem = {
        id: 'folder-1',
        type: 'folder' as const,
        name: 'Folder',
        _oc: { info: { name: 'Folder' }, items: [reqOc] },
        items: [reqItem],
      };
      const collection = {
        id: 'col-1',
        name: 'Imported',
        _oc: { opencollection: '1.0.0', info: { name: 'Imported' }, items: [folderItem._oc] },
        items: [folderItem],
      } as unknown as Collection;
      addCollection(collection);

      // Edit the nested request in-app: GET -> POST.
      updateCollectionItem('col-1', 'req-1', {
        request: { ...reqItem.request, method: 'POST' },
      });

      const edited = useCollectionStore.getState().collections.find((c) => c.id === 'col-1')!;
      const oc = internalToOC(edited as Collection & { _oc?: unknown }) as {
        items: Array<{ items: Array<{ http: { method: string } }> }>;
      };
      expect(oc.items[0]!.items[0]!.http.method).toBe('POST');
    });
  });

  describe('moveCollectionItem defeats stale _oc bags on move (audit Fix 7, move path)', () => {
    it('re-exports a moved request in its new folder, not the pre-move layout', () => {
      const { addCollection, moveCollectionItem } = useCollectionStore.getState();

      const reqOc = {
        info: { type: 'http', name: 'A' },
        http: { method: 'GET', url: 'https://api.example.com/a' },
      };
      const reqA = {
        id: 'a',
        type: 'request' as const,
        name: 'A',
        _oc: reqOc,
        request: {
          id: 'a',
          name: 'A',
          type: 'http' as const,
          method: 'GET' as const,
          url: 'https://api.example.com/a',
          headers: [],
          params: [],
          body: { type: 'none' as const },
          auth: { type: 'none' as const },
        },
      };
      const f1 = {
        id: 'f1',
        type: 'folder' as const,
        name: 'F1',
        _oc: { info: { name: 'F1' }, items: [reqOc] },
        items: [reqA],
      };
      const f2 = {
        id: 'f2',
        type: 'folder' as const,
        name: 'F2',
        _oc: { info: { name: 'F2' }, items: [] },
        items: [],
      };
      const collection = {
        id: 'c',
        name: 'Imp',
        _oc: { opencollection: '1.0.0', info: { name: 'Imp' }, items: [f1._oc, f2._oc] },
        items: [f1, f2],
      } as unknown as Collection;
      addCollection(collection);

      moveCollectionItem('c', 'a', { parentId: 'f2' });

      const edited = useCollectionStore.getState().collections.find((c) => c.id === 'c')!;
      const oc = internalToOC(edited as Collection & { _oc?: unknown }) as {
        items: Array<{ info: { name: string }; items: Array<{ info: { name: string } }> }>;
      };
      const ocF1 = oc.items.find((i) => i.info.name === 'F1')!;
      const ocF2 = oc.items.find((i) => i.info.name === 'F2')!;
      expect(ocF1.items).toHaveLength(0);
      expect(ocF2.items).toHaveLength(1);
      expect(ocF2.items[0]!.info.name).toBe('A');
    });

    it('handles a beforeId reorder into another folder (parentId undefined)', () => {
      const { addCollection, moveCollectionItem } = useCollectionStore.getState();

      const mk = (id: string, name: string) => ({
        id,
        type: 'request' as const,
        name,
        _oc: {
          info: { type: 'http', name },
          http: { method: 'GET', url: `https://api.example.com/${id}` },
        },
        request: {
          id,
          name,
          type: 'http' as const,
          method: 'GET' as const,
          url: `https://api.example.com/${id}`,
          headers: [],
          params: [],
          body: { type: 'none' as const },
          auth: { type: 'none' as const },
        },
      });
      const a = mk('a', 'A');
      const b = mk('b', 'B');
      const f1 = {
        id: 'f1',
        type: 'folder' as const,
        name: 'F1',
        _oc: { info: { name: 'F1' }, items: [a._oc] },
        items: [a],
      };
      const f2 = {
        id: 'f2',
        type: 'folder' as const,
        name: 'F2',
        _oc: { info: { name: 'F2' }, items: [b._oc] },
        items: [b],
      };
      const collection = {
        id: 'c',
        name: 'Imp',
        _oc: { opencollection: '1.0.0', info: { name: 'Imp' }, items: [f1._oc, f2._oc] },
        items: [f1, f2],
      } as unknown as Collection;
      addCollection(collection);

      // Drag A to sit before B (which lives in F2) — parentId is undefined.
      moveCollectionItem('c', 'a', { beforeId: 'b' });

      const edited = useCollectionStore.getState().collections.find((c) => c.id === 'c')!;
      const oc = internalToOC(edited as Collection & { _oc?: unknown }) as {
        items: Array<{ info: { name: string }; items: Array<{ info: { name: string } }> }>;
      };
      const ocF2 = oc.items.find((i) => i.info.name === 'F2')!;
      expect(ocF2.items.map((i) => i.info.name)).toEqual(['A', 'B']);
    });
  });

  describe('add/remove also defeat stale _oc bags (audit Fix 7, completeness)', () => {
    const mkReq = (id: string, name: string, method: 'GET' | 'POST' = 'GET') => ({
      id,
      type: 'request' as const,
      name,
      _oc: {
        info: { type: 'http', name },
        http: { method, url: `https://api.example.com/${id}` },
      },
      request: {
        id,
        name,
        type: 'http' as const,
        method,
        url: `https://api.example.com/${id}`,
        headers: [],
        params: [],
        body: { type: 'none' as const },
        auth: { type: 'none' as const },
      },
    });

    it('a request added to an imported folder appears on re-export', () => {
      const { addCollection, addItemToCollection } = useCollectionStore.getState();
      const a = mkReq('a', 'A');
      const f1 = {
        id: 'f1',
        type: 'folder' as const,
        name: 'F1',
        _oc: { info: { name: 'F1' }, items: [a._oc] },
        items: [a],
      };
      const collection = {
        id: 'c',
        name: 'Imp',
        _oc: { opencollection: '1.0.0', info: { name: 'Imp' }, items: [f1._oc] },
        items: [f1],
      } as unknown as Collection;
      addCollection(collection);

      const newReq = {
        id: 'b',
        type: 'request' as const,
        name: 'B',
        request: {
          id: 'b',
          name: 'B',
          type: 'http' as const,
          method: 'POST' as const,
          url: 'https://api.example.com/b',
          headers: [],
          params: [],
          body: { type: 'none' as const },
          auth: { type: 'none' as const },
        },
      } as unknown as CollectionItem;
      addItemToCollection('c', newReq, 'f1');

      const edited = useCollectionStore.getState().collections.find((c) => c.id === 'c')!;
      const oc = internalToOC(edited as Collection & { _oc?: unknown }) as {
        items: Array<{ info: { name: string }; items: Array<{ info: { name: string } }> }>;
      };
      const ocF1 = oc.items.find((i) => i.info.name === 'F1')!;
      expect(ocF1.items.map((i) => i.info.name)).toEqual(['A', 'B']);
    });

    it('a request removed from an imported folder stays removed on re-export', () => {
      const { addCollection, removeCollectionItem } = useCollectionStore.getState();
      const a = mkReq('a', 'A');
      const b = mkReq('b', 'B');
      const f1 = {
        id: 'f1',
        type: 'folder' as const,
        name: 'F1',
        _oc: { info: { name: 'F1' }, items: [a._oc, b._oc] },
        items: [a, b],
      };
      const collection = {
        id: 'c',
        name: 'Imp',
        _oc: { opencollection: '1.0.0', info: { name: 'Imp' }, items: [f1._oc] },
        items: [f1],
      } as unknown as Collection;
      addCollection(collection);

      removeCollectionItem('c', 'b');

      const edited = useCollectionStore.getState().collections.find((c) => c.id === 'c')!;
      const oc = internalToOC(edited as Collection & { _oc?: unknown }) as {
        items: Array<{ info: { name: string }; items: Array<{ info: { name: string } }> }>;
      };
      const ocF1 = oc.items.find((i) => i.info.name === 'F1')!;
      expect(ocF1.items.map((i) => i.info.name)).toEqual(['A']);
    });
  });

  describe('updateCollection', () => {
    it('should update collection properties', () => {
      const { createNewCollection, addCollection, updateCollection } =
        useCollectionStore.getState();
      const collection = createNewCollection('Old Name');
      addCollection(collection);

      updateCollection(collection.id, {
        name: 'New Name',
        description: 'Updated description',
      });

      const state = useCollectionStore.getState();
      expect(state.collections[0]?.name).toBe('New Name');
      expect(state.collections[0]?.description).toBe('Updated description');
    });
  });

  describe('removeCollection', () => {
    it('should remove collection from list', () => {
      const { createNewCollection, addCollection, removeCollection } =
        useCollectionStore.getState();
      const collection = createNewCollection('To Delete');
      addCollection(collection);

      removeCollection(collection.id);

      const state = useCollectionStore.getState();
      expect(state.collections).toHaveLength(0);
    });

    it('should clear activeCollectionId if deleted', () => {
      const { createNewCollection, addCollection, setActiveCollection, removeCollection } =
        useCollectionStore.getState();
      const collection = createNewCollection('Active');
      addCollection(collection);
      setActiveCollection(collection.id);

      removeCollection(collection.id);

      const state = useCollectionStore.getState();
      expect(state.activeCollectionId).toBeNull();
    });
  });

  describe('addItemToCollection', () => {
    it('should add item to root level', () => {
      const { createNewCollection, addCollection, addItemToCollection } =
        useCollectionStore.getState();
      const collection = createNewCollection('Test');
      addCollection(collection);

      const item: CollectionItem = {
        id: 'item-1',
        name: 'GET Users',
        type: 'request',
      };

      addItemToCollection(collection.id, item);

      const state = useCollectionStore.getState();
      expect(state.collections[0]?.items).toHaveLength(1);
      expect(state.collections[0]?.items[0]).toEqual(item);
    });

    it('should add item to folder', () => {
      const { createNewCollection, addCollection, addItemToCollection } =
        useCollectionStore.getState();
      const collection = createNewCollection('Test');
      addCollection(collection);

      const folder: CollectionItem = {
        id: 'folder-1',
        name: 'User APIs',
        type: 'folder',
        items: [],
      };

      addItemToCollection(collection.id, folder);

      const request: CollectionItem = {
        id: 'request-1',
        name: 'GET Users',
        type: 'request',
      };

      addItemToCollection(collection.id, request, 'folder-1');

      const state = useCollectionStore.getState();
      const folderItem = state.collections[0]?.items[0];
      expect(folderItem?.items).toHaveLength(1);
      expect(folderItem?.items?.[0]).toEqual(request);
    });
  });

  describe('updateCollectionItem', () => {
    it('should update item in collection', () => {
      const { createNewCollection, addCollection, addItemToCollection, updateCollectionItem } =
        useCollectionStore.getState();
      const collection = createNewCollection('Test');
      addCollection(collection);

      const item: CollectionItem = {
        id: 'item-1',
        name: 'Old Name',
        type: 'request',
      };

      addItemToCollection(collection.id, item);
      updateCollectionItem(collection.id, 'item-1', { name: 'New Name' });

      const state = useCollectionStore.getState();
      expect(state.collections[0]?.items[0]?.name).toBe('New Name');
    });

    it('should update nested item', () => {
      const { createNewCollection, addCollection, addItemToCollection, updateCollectionItem } =
        useCollectionStore.getState();
      const collection = createNewCollection('Test');
      addCollection(collection);

      const folder: CollectionItem = {
        id: 'folder-1',
        name: 'Folder',
        type: 'folder',
        items: [
          {
            id: 'nested-item',
            name: 'Old Name',
            type: 'request',
          },
        ],
      };

      addItemToCollection(collection.id, folder);
      updateCollectionItem(collection.id, 'nested-item', { name: 'New Name' });

      const state = useCollectionStore.getState();
      expect(state.collections[0]?.items[0]?.items?.[0]?.name).toBe('New Name');
    });
  });

  describe('removeCollectionItem', () => {
    it('should remove item from collection', () => {
      const { createNewCollection, addCollection, addItemToCollection, removeCollectionItem } =
        useCollectionStore.getState();
      const collection = createNewCollection('Test');
      addCollection(collection);

      const item: CollectionItem = {
        id: 'item-1',
        name: 'To Delete',
        type: 'request',
      };

      addItemToCollection(collection.id, item);
      removeCollectionItem(collection.id, 'item-1');

      const state = useCollectionStore.getState();
      expect(state.collections[0]?.items).toHaveLength(0);
    });

    it('should remove nested item', () => {
      const { createNewCollection, addCollection, addItemToCollection, removeCollectionItem } =
        useCollectionStore.getState();
      const collection = createNewCollection('Test');
      addCollection(collection);

      const folder: CollectionItem = {
        id: 'folder-1',
        name: 'Folder',
        type: 'folder',
        items: [
          {
            id: 'nested-item',
            name: 'To Delete',
            type: 'request',
          },
        ],
      };

      addItemToCollection(collection.id, folder);
      removeCollectionItem(collection.id, 'nested-item');

      const state = useCollectionStore.getState();
      expect(state.collections[0]?.items[0]?.items).toHaveLength(0);
    });
  });

  describe('getCollectionById', () => {
    it('should return collection by id', () => {
      const { createNewCollection, addCollection, getCollectionById } =
        useCollectionStore.getState();
      const collection = createNewCollection('Test');
      addCollection(collection);

      const found = getCollectionById(collection.id);
      expect(found).toEqual(collection);
    });

    it('should return undefined for non-existent id', () => {
      const { getCollectionById } = useCollectionStore.getState();
      const found = getCollectionById('non-existent');
      expect(found).toBeUndefined();
    });
  });

  describe('moveCollectionItem', () => {
    // Builds: collection "c" with [ folderA[req1], req2 ]
    function seed() {
      const req1: CollectionItem = { id: 'req1', name: 'Req 1', type: 'request' };
      const folderA: CollectionItem = { id: 'fA', name: 'Folder A', type: 'folder', items: [req1] };
      const req2: CollectionItem = { id: 'req2', name: 'Req 2', type: 'request' };
      useCollectionStore.setState({
        collections: [{ id: 'c', name: 'C', items: [folderA, req2] }],
        activeCollectionId: null,
      });
    }

    it('reparents a root item into a folder', () => {
      seed();
      useCollectionStore.getState().moveCollectionItem('c', 'req2', { parentId: 'fA' });
      const col = useCollectionStore.getState().collections[0]!;
      expect(col.items.map((i) => i.id)).toEqual(['fA']);
      expect(col.items[0]!.items!.map((i) => i.id)).toEqual(['req1', 'req2']);
    });

    it('reorders siblings via beforeId', () => {
      seed();
      // Move req2 before folderA at root.
      useCollectionStore.getState().moveCollectionItem('c', 'req2', { beforeId: 'fA' });
      const col = useCollectionStore.getState().collections[0]!;
      expect(col.items.map((i) => i.id)).toEqual(['req2', 'fA']);
    });

    it('no-ops a self-drop (beforeId === itemId)', () => {
      seed();
      useCollectionStore.getState().moveCollectionItem('c', 'fA', { beforeId: 'fA' });
      const col = useCollectionStore.getState().collections[0]!;
      expect(col.items.map((i) => i.id)).toEqual(['fA', 'req2']);
    });

    it('reorders before a folder-nested sibling, landing inside that folder', () => {
      seed(); // c: [ fA[req1], req2 ]
      // Drop req2 before req1, which lives inside folder fA.
      useCollectionStore.getState().moveCollectionItem('c', 'req2', { beforeId: 'req1' });
      const col = useCollectionStore.getState().collections[0]!;
      expect(col.items.map((i) => i.id)).toEqual(['fA']);
      expect(col.items[0]!.items!.map((i) => i.id)).toEqual(['req2', 'req1']);
    });

    it('is a no-op (no data loss) when parentId is not a folder', () => {
      seed();
      // req2 is a request, not a folder — dropping into it must not lose req1.
      useCollectionStore.getState().moveCollectionItem('c', 'req1', { parentId: 'req2' });
      const col = useCollectionStore.getState().collections[0]!;
      expect(col.items[0]!.items!.map((i) => i.id)).toEqual(['req1']);
      expect(col.items.map((i) => i.id)).toEqual(['fA', 'req2']);
    });

    it('is a no-op when beforeId does not exist (no data loss)', () => {
      seed();
      useCollectionStore.getState().moveCollectionItem('c', 'req2', { beforeId: 'ghost' });
      const col = useCollectionStore.getState().collections[0]!;
      expect(col.items.map((i) => i.id)).toEqual(['fA', 'req2']);
    });

    it('refuses to drop a folder into its own descendant', () => {
      // folderOuter[ folderInner[] ] — moving folderOuter into folderInner is a cycle.
      const inner: CollectionItem = { id: 'inner', name: 'Inner', type: 'folder', items: [] };
      const outer: CollectionItem = { id: 'outer', name: 'Outer', type: 'folder', items: [inner] };
      useCollectionStore.setState({
        collections: [{ id: 'c', name: 'C', items: [outer] }],
        activeCollectionId: null,
      });
      useCollectionStore.getState().moveCollectionItem('c', 'outer', { parentId: 'inner' });
      const col = useCollectionStore.getState().collections[0]!;
      // Unchanged: outer still at root containing inner.
      expect(col.items.map((i) => i.id)).toEqual(['outer']);
      expect(col.items[0]!.items!.map((i) => i.id)).toEqual(['inner']);
    });
  });

  describe('migrate', () => {
    it('passes a current-version blob through (with v<3 auth migration applied)', () => {
      const opts = useCollectionStore.persist.getOptions();
      const result = (opts.migrate as (s: unknown, v: number) => unknown)(
        { collections: [{ id: 'fresh', name: 'F', items: [] }] },
        3
      );
      expect((result as { collections: Array<{ id: string }> }).collections[0]!.id).toBe('fresh');
    });

    it('handles an empty/first-run blob without throwing', () => {
      const opts = useCollectionStore.persist.getOptions();
      expect(() => (opts.migrate as (s: unknown, v: number) => unknown)({}, 3)).not.toThrow();
    });
  });
});
