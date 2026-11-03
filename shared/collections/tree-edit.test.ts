import { describe, expect, it } from 'vitest';
import { OC_STALE_KEY } from '../opencollection/stale-bag';
import type { Collection, CollectionItem } from '../types';
import { moveItem, stripForDuplicate, updateItem } from './tree-edit';

/** Folder bags shaped like real OC folders (B1): staled, never deleted, on a subtree edit. */
const req = (id: string): CollectionItem =>
  Object.assign(
    {
      id,
      name: id,
      type: 'request' as const,
      request: {
        id: `${id}-r`,
        name: id,
        type: 'http' as const,
        method: 'GET',
        url: 'http://x',
        headers: [],
        params: [],
        body: { type: 'none' as const },
        auth: { type: 'none' as const },
      },
    },
    { _oc: { info: { type: 'http', name: id }, http: { method: 'GET', url: 'http://x' } } }
  );

const folder = (id: string, items: CollectionItem[], extra: object = {}): CollectionItem =>
  Object.assign(
    { id, name: id, type: 'folder' as const, items },
    {
      _oc: { info: { name: id, description: `${id} desc` }, docs: `${id} docs`, items: [] },
      ...extra,
    }
  );

const fixture = (): Collection => ({
  id: 'c',
  name: 'C',
  items: [folder('F', [folder('G', [req('R')])]), folder('H', [])],
});

const find = (items: CollectionItem[], id: string): CollectionItem | undefined => {
  for (const i of items) {
    if (i.id === id) return i;
    const hit = i.items ? find(i.items, id) : undefined;
    if (hit) return hit;
  }
  return undefined;
};

const bag = (c: Collection, id: string) => {
  const node = find(c.items, id);
  if (!node) throw new Error(id);
  return { oc: Reflect.get(node, '_oc'), stale: Reflect.get(node, OC_STALE_KEY) };
};

describe('tree-edit stales OC folder bags instead of deleting them (B1)', () => {
  it('a request edit drops the request bag and stales every ancestor folder bag', () => {
    const out = updateItem(fixture(), 'R', { name: 'R2' });
    expect(bag(out, 'R').oc).toBeUndefined();
    for (const id of ['F', 'G']) {
      expect(bag(out, id)).toEqual({
        oc: { info: { name: id, description: `${id} desc` }, docs: `${id} docs` },
        stale: true,
      });
    }
    expect(bag(out, 'H').stale).toBeUndefined();
  });

  it('a folder own-auth edit stales its bag and drops its Postman guard markers', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [folder('F', [], { _postman: { noauth: true } })],
    };
    const out = updateItem(c, 'F', { auth: { type: 'bearer', bearer: { token: 't' } } as never });
    const node = find(out.items, 'F');
    expect(node && Reflect.get(node, '_postman')).toBeUndefined();
    expect(bag(out, 'F').stale).toBe(true);
  });

  it('a moved folder and both ancestor chains are staled', () => {
    const out = moveItem(fixture(), 'G', { parentId: 'H' });
    expect(['F', 'G', 'H'].map((id) => bag(out, id).stale)).toEqual([true, true, true]);
  });

  it('a non-folder bag on an internal folder (unknown-type placeholder) is dropped, not staled', () => {
    const placeholder = Object.assign(
      { id: 'P', name: 'P (Unknown type: x)', type: 'folder' as const, items: [req('R')] },
      { _oc: { info: { type: 'x', name: 'P' } } }
    );
    const out = updateItem({ id: 'c', name: 'C', items: [placeholder] }, 'R', { name: 'R2' });
    expect(bag(out, 'P')).toEqual({ oc: undefined, stale: undefined });
  });

  it('a duplicate loses the stale marker with the bag', () => {
    const staled = updateItem(fixture(), 'R', { name: 'R2' });
    const copy = stripForDuplicate(structuredClone(find(staled.items, 'F') as CollectionItem));
    expect(Reflect.get(copy, '_oc')).toBeUndefined();
    expect(Reflect.get(copy, OC_STALE_KEY)).toBeUndefined();
  });
});
