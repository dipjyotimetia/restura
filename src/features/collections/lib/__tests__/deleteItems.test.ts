import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { Collection, HttpRequest, RequestTab } from '@/types';
import { deleteCollectionItems, describeItemDeletion } from '../deleteItems';

const request = (id: string): HttpRequest => ({
  id,
  name: id,
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
});

const collection: Collection = {
  id: 'c',
  name: 'Collection',
  items: [
    {
      id: 'folder',
      name: 'Users',
      type: 'folder',
      items: [
        { id: 'nested', name: 'Get user', type: 'request', request: request('r1') },
        {
          id: 'sub',
          name: 'Admin',
          type: 'folder',
          items: [{ id: 'deep', name: 'Ban', type: 'request', request: request('r2') }],
        },
      ],
    },
    { id: 'other', name: 'Health', type: 'request', request: request('r3') },
  ],
};

const tab = (id: string, savedRequestId: string) =>
  ({ id, request: request(id), savedRequestId, isDirty: false }) as RequestTab;

describe('deleteCollectionItems', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [collection] });
    useRequestStore.setState({
      tabs: [tab('t1', 'nested'), tab('t2', 'deep'), tab('t3', 'other')],
      activeTabId: 't1',
    });
  });

  it('detaches tabs opened from the deleted item and its descendants', () => {
    deleteCollectionItems('c', ['folder']);
    const tabs = useRequestStore.getState().tabs;
    expect(tabs[0]).not.toHaveProperty('savedRequestId');
    expect(tabs[1]).not.toHaveProperty('savedRequestId');
    expect(tabs[0]).toMatchObject({ isDirty: true });
    expect(tabs[2]).toMatchObject({ savedRequestId: 'other' });
    expect(useCollectionStore.getState().collections[0]?.items.map((i) => i.id)).toEqual(['other']);
  });
});

describe('describeItemDeletion', () => {
  beforeEach(() => useCollectionStore.setState({ collections: [collection] }));

  it('names a folder and counts what is inside it', () => {
    expect(describeItemDeletion('c', ['folder'])).toEqual({
      title: 'Delete "Users"',
      description:
        'Delete the folder "Users" and the 3 items inside it (2 requests)? This action cannot be undone.',
    });
  });

  it('names a single request', () => {
    expect(describeItemDeletion('c', ['other'])).toEqual({
      title: 'Delete "Health"',
      description: 'Delete the request "Health"? This action cannot be undone.',
    });
  });

  it('counts a multi-selection including descendants', () => {
    expect(describeItemDeletion('c', ['folder', 'other'])).toEqual({
      title: 'Delete 2 items',
      description:
        'Delete 2 selected items ("Users", "Health") and the 3 items inside them? This action cannot be undone.',
    });
  });
});

describe('deleteItems edge cases', () => {
  const small: Collection = {
    id: 's',
    name: 'Small',
    items: [
      { id: 'empty', name: 'Empty', type: 'folder', items: [] },
      { id: 'bare', name: 'Bare', type: 'folder' },
      {
        id: 'one',
        name: 'One',
        type: 'folder',
        items: [{ id: 'only', name: 'Only', type: 'request', request: request('r9') }],
      },
      { id: 'leaf', name: 'Leaf', type: 'request', request: request('r8') },
    ],
  };

  beforeEach(() => {
    useCollectionStore.setState({ collections: [small] });
    useRequestStore.setState({ tabs: [tab('t1', 'leaf')], activeTabId: 't1' });
  });

  it('falls back to generic copy for unknown items or collections', () => {
    const generic = {
      title: 'Delete item',
      description: 'Delete this item? This action cannot be undone.',
    };
    expect(describeItemDeletion('s', ['missing'])).toEqual(generic);
    expect(describeItemDeletion('nope', ['leaf'])).toEqual(generic);
  });

  it('describes empty folders without an inside clause', () => {
    expect(describeItemDeletion('s', ['empty']).description).toBe(
      'Delete the folder "Empty"? This action cannot be undone.'
    );
    expect(describeItemDeletion('s', ['bare']).description).toBe(
      'Delete the folder "Bare"? This action cannot be undone.'
    );
  });

  it('uses singular nouns for a single descendant', () => {
    expect(describeItemDeletion('s', ['one']).description).toBe(
      'Delete the folder "One" and the 1 item inside it (1 request)? This action cannot be undone.'
    );
    expect(describeItemDeletion('s', ['one', 'empty']).description).toBe(
      'Delete 2 selected items ("One", "Empty") and the 1 item inside them? This action cannot be undone.'
    );
  });

  it('omits the inside clause for a multi-selection with no descendants', () => {
    expect(describeItemDeletion('s', ['leaf', 'empty', 'missing'])).toEqual({
      title: 'Delete 2 items',
      description: 'Delete 2 selected items ("Leaf", "Empty")? This action cannot be undone.',
    });
  });

  it('leaves tabs alone when nothing matched', () => {
    deleteCollectionItems('s', ['missing']);
    deleteCollectionItems('unknown-collection', ['leaf']);
    expect(useRequestStore.getState().tabs[0]).toMatchObject({ savedRequestId: 'leaf' });
    expect(useCollectionStore.getState().collections[0]?.items).toHaveLength(4);
  });

  it('removes a nested request found by deep search', () => {
    deleteCollectionItems('s', ['only', 'leaf']);
    const items = useCollectionStore.getState().collections[0]?.items ?? [];
    expect(items.map((i) => i.id)).toEqual(['empty', 'bare', 'one']);
    expect(items[2]?.items).toEqual([]);
    expect(useRequestStore.getState().tabs[0]).not.toHaveProperty('savedRequestId');
  });
});
