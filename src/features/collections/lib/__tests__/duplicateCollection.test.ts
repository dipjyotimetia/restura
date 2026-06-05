import { describe, it, expect } from 'vitest';
import { duplicateCollection } from '../itemFactory';
import type { Collection, CollectionItem, HttpRequest } from '@/types';

const req = (id: string, name: string): CollectionItem => {
  const request: HttpRequest = {
    id: `${id}-req`,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://example.com',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
  return { id, name, type: 'request', request };
};

const source: Collection = {
  id: 'col-1',
  name: 'My API',
  description: 'desc',
  auth: { type: 'bearer', bearer: { token: 't' } },
  variables: [{ id: 'v1', key: 'base', value: 'https://x', enabled: true }],
  items: [
    {
      id: 'f1',
      name: 'Folder',
      type: 'folder',
      items: [req('r1', 'Nested')],
    },
    req('r2', 'Top level'),
  ],
};

describe('duplicateCollection', () => {
  it('appends " copy" to the name and keeps content', () => {
    const dup = duplicateCollection(source);
    expect(dup.name).toBe('My API copy');
    expect(dup.description).toBe('desc');
    expect(dup.auth).toEqual(source.auth);
    expect(dup.items).toHaveLength(2);
    expect(dup.items[0]!.items![0]!.name).toBe('Nested');
  });

  it('regenerates the collection id and every item/request/variable id', () => {
    const dup = duplicateCollection(source);
    expect(dup.id).not.toBe(source.id);

    const collectIds = (items: CollectionItem[]): string[] =>
      items.flatMap((i) => [
        i.id,
        ...(i.request ? [i.request.id] : []),
        ...(i.items ? collectIds(i.items) : []),
      ]);
    const sourceIds = new Set(collectIds(source.items));
    for (const id of collectIds(dup.items)) {
      expect(sourceIds.has(id)).toBe(false);
    }
    expect(dup.variables![0]!.id).not.toBe(source.variables![0]!.id);
    expect(dup.variables![0]!.key).toBe('base');
  });

  it('is a deep copy — mutating the duplicate leaves the source untouched', () => {
    const dup = duplicateCollection(source);
    dup.items[0]!.items![0]!.name = 'MUTATED';
    expect(source.items[0]!.items![0]!.name).toBe('Nested');
  });
});
