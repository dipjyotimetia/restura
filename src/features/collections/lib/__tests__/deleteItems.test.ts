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
