import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/types';
import { countRequests } from '../countRequests';
import { flattenRunnables } from '../flattenRunnables';

const req = (id: string): CollectionItem =>
  ({
    id,
    name: id,
    type: 'request',
    request: {
      id,
      name: id,
      type: 'http',
      method: 'GET',
      url: 'https://x.test',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
  }) as CollectionItem;

describe('countRequests', () => {
  it('counts requests recursively and matches the run dialog', () => {
    const items: CollectionItem[] = [
      req('a'),
      {
        id: 'f',
        name: 'f',
        type: 'folder',
        items: [req('b'), req('c'), { id: 'g', name: 'g', type: 'folder', items: [req('d')] }],
      },
      { id: 'e', name: 'empty', type: 'folder', items: [] },
    ];
    expect(countRequests(items)).toBe(4);
    expect(countRequests(items)).toBe(flattenRunnables(items).length);
  });
});
