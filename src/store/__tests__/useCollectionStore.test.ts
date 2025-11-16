import { describe, it, expect, beforeEach } from 'vitest';
import { useCollectionStore } from '../useCollectionStore';
import { CollectionItem } from '@/types';

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

  describe('deleteCollection', () => {
    it('should remove collection from list', () => {
      const { createNewCollection, addCollection, deleteCollection } =
        useCollectionStore.getState();
      const collection = createNewCollection('To Delete');
      addCollection(collection);

      deleteCollection(collection.id);

      const state = useCollectionStore.getState();
      expect(state.collections).toHaveLength(0);
    });

    it('should clear activeCollectionId if deleted', () => {
      const { createNewCollection, addCollection, setActiveCollection, deleteCollection } =
        useCollectionStore.getState();
      const collection = createNewCollection('Active');
      addCollection(collection);
      setActiveCollection(collection.id);

      deleteCollection(collection.id);

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

  describe('deleteCollectionItem', () => {
    it('should remove item from collection', () => {
      const { createNewCollection, addCollection, addItemToCollection, deleteCollectionItem } =
        useCollectionStore.getState();
      const collection = createNewCollection('Test');
      addCollection(collection);

      const item: CollectionItem = {
        id: 'item-1',
        name: 'To Delete',
        type: 'request',
      };

      addItemToCollection(collection.id, item);
      deleteCollectionItem(collection.id, 'item-1');

      const state = useCollectionStore.getState();
      expect(state.collections[0]?.items).toHaveLength(0);
    });

    it('should remove nested item', () => {
      const { createNewCollection, addCollection, addItemToCollection, deleteCollectionItem } =
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
      deleteCollectionItem(collection.id, 'nested-item');

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
});
