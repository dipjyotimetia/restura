import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem } from '@/types';
import { exportBrunoCollection } from '../bruno-exporter';

function req(name: string): CollectionItem {
  return {
    id: name,
    name,
    type: 'request',
    request: {
      id: name,
      name,
      type: 'http',
      method: 'GET',
      url: `https://x.test/${name}`,
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
  } as CollectionItem;
}

describe('exportBrunoCollection sibling name collisions', () => {
  it('does not overwrite requests whose sanitised names collide', async () => {
    const collection: Collection = {
      id: 'c',
      name: 'c',
      items: [req('a/b'), req('a:b'), req('A_B')],
    };
    const out = await exportBrunoCollection(collection);
    if (out.kind !== 'directory') throw new Error('expected directory');
    const bru = out.entries.map((e) => e.relativePath).filter((p) => p.endsWith('.bru'));
    expect(new Set(bru.map((p) => p.toLowerCase())).size).toBe(3);
    expect(bru).toContain('a_b.bru');
    expect(bru).toContain('a_b-2.bru');
    expect(bru).toContain('A_B-3.bru');
  });

  it('dedupes folders too', async () => {
    const folder = (name: string): CollectionItem =>
      ({ id: name, name, type: 'folder', items: [req('r')] }) as CollectionItem;
    const out = await exportBrunoCollection({
      id: 'c',
      name: 'c',
      items: [folder('x?'), folder('x*')],
    });
    if (out.kind !== 'directory') throw new Error('expected directory');
    const paths = out.entries.map((e) => e.relativePath).filter((p) => p.endsWith('r.bru'));
    expect(paths).toEqual(['x/r.bru', 'x-2/r.bru']);
  });
});
