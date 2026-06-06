import { describe, it, expect, beforeEach } from 'vitest';
import { resolveInheritedAuthFor } from '../resolveInheritedAuthFor';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { AuthConfig, Collection, CollectionItem, HttpRequest } from '@/types';

const bearer = (token: string): AuthConfig => ({ type: 'bearer', bearer: { token } });

const request = (id: string, auth: AuthConfig = { type: 'none' }): HttpRequest => ({
  id,
  name: 'R',
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth,
});

const requestItem = (reqId: string): CollectionItem => ({
  id: `item-${reqId}`,
  name: 'R',
  type: 'request',
  request: request(reqId),
});

function seedCollections(collections: Collection[]) {
  useCollectionStore.setState({ collections });
}

describe('resolveInheritedAuthFor', () => {
  beforeEach(() => {
    seedCollections([]);
  });

  it('returns undefined when the request has its own configured auth', () => {
    seedCollections([{ id: 'c1', name: 'C', auth: bearer('col'), items: [requestItem('r1')] }]);
    expect(resolveInheritedAuthFor(request('r1', bearer('own')))).toBeUndefined();
  });

  it('resolves collection auth with the collection name as source', () => {
    seedCollections([
      { id: 'c1', name: 'My API', auth: bearer('col'), items: [requestItem('r1')] },
    ]);
    const result = resolveInheritedAuthFor(request('r1'));
    expect(result?.auth).toEqual(bearer('col'));
    expect(result?.sourceName).toBe('My API');
  });

  it('nearest folder auth wins, with the folder name as source', () => {
    seedCollections([
      {
        id: 'c1',
        name: 'My API',
        auth: bearer('col'),
        items: [
          {
            id: 'f1',
            name: 'Staging',
            type: 'folder',
            auth: bearer('folder'),
            items: [requestItem('r1')],
          },
        ],
      },
    ]);
    const result = resolveInheritedAuthFor(request('r1'));
    expect(result?.auth).toEqual(bearer('folder'));
    expect(result?.sourceName).toBe('Staging');
  });

  it('returns undefined for a request not saved in any collection', () => {
    seedCollections([{ id: 'c1', name: 'C', auth: bearer('col'), items: [requestItem('r1')] }]);
    expect(resolveInheritedAuthFor(request('scratch-tab'))).toBeUndefined();
  });

  it('returns undefined when no ancestor has configured auth', () => {
    seedCollections([{ id: 'c1', name: 'C', items: [requestItem('r1')] }]);
    expect(resolveInheritedAuthFor(request('r1'))).toBeUndefined();
  });

  it('finds the request in a later collection', () => {
    seedCollections([
      { id: 'c1', name: 'First', items: [requestItem('other')] },
      { id: 'c2', name: 'Second', auth: bearer('second'), items: [requestItem('r1')] },
    ]);
    const result = resolveInheritedAuthFor(request('r1'));
    expect(result?.auth).toEqual(bearer('second'));
    expect(result?.sourceName).toBe('Second');
  });
});
