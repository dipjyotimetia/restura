import { describe, it, expect, beforeEach } from 'vitest';
import { useCollectionStore } from '../useCollectionStore';
import type { CollectionItem } from '@/types';

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

  describe('legacy localStorage migration', () => {
    it('rehydrates from legacy localStorage when Dexie is empty', () => {
      localStorage.setItem(
        'collection-storage',
        JSON.stringify({
          state: { collections: [{ id: 'c1', name: 'Legacy', items: [] }] },
          version: 1,
        })
      );
      const opts = useCollectionStore.persist.getOptions();
      const result = (opts.migrate as (s: unknown, v: number) => unknown)({}, 1);
      expect((result as { collections: Array<{ id: string }> }).collections[0]!.id).toBe('c1');
      expect(localStorage.getItem('collection-storage')).toBeNull();
    });

    it('does not consume legacy when Dexie returned real data', () => {
      localStorage.setItem(
        'collection-storage',
        JSON.stringify({
          state: { collections: [{ id: 'legacy', name: 'L', items: [] }] },
          version: 1,
        })
      );
      const opts = useCollectionStore.persist.getOptions();
      const result = (opts.migrate as (s: unknown, v: number) => unknown)(
        { collections: [{ id: 'fresh', name: 'F', items: [] }] },
        1
      );
      expect((result as { collections: Array<{ id: string }> }).collections[0]!.id).toBe('fresh');
      // Legacy key NOT consumed when Dexie had real data
      expect(localStorage.getItem('collection-storage')).toBeTruthy();
    });
  });
});
