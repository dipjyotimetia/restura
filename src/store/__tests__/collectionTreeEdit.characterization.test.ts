import * as treeEdit from '@shared/collections/tree-edit';
import { beforeEach, describe, expect, it } from 'vitest';
import { duplicateCollection } from '@/features/collections/lib/itemFactory';
import type { Collection, CollectionItem, HttpRequest } from '@/types';
import { useCollectionStore } from '../useCollectionStore';

/**
 * Characterization of passthrough-bag staleness for every collection-tree
 * mutation. The same scenarios run against two drivers: the Zustand store
 * (the behaviour as it shipped) and the pure `tree-edit` module that the store
 * delegates to. Both must agree, so the module is a behaviour-preserving
 * extraction.
 */

interface Driver {
  name: string;
  add(col: Collection, item: CollectionItem, parentId?: string): Collection;
  update(col: Collection, itemId: string, updates: Partial<CollectionItem>): Collection;
  remove(col: Collection, itemId: string): Collection;
  move(
    col: Collection,
    itemId: string,
    target: { parentId?: string; beforeId?: string }
  ): Collection;
  root(col: Collection, updates: Partial<Collection>): Collection;
}

function viaStore(run: (s: ReturnType<typeof useCollectionStore.getState>, id: string) => void) {
  return (col: Collection): Collection => {
    useCollectionStore.setState({ collections: [col], activeCollectionId: null });
    run(useCollectionStore.getState(), col.id);
    return useCollectionStore.getState().collections[0]!;
  };
}

const storeDriver: Driver = {
  name: 'store',
  add: (col, item, parentId) => viaStore((s, id) => s.addItemToCollection(id, item, parentId))(col),
  update: (col, itemId, updates) =>
    viaStore((s, id) => s.updateCollectionItem(id, itemId, updates))(col),
  remove: (col, itemId) => viaStore((s, id) => s.removeCollectionItem(id, itemId))(col),
  move: (col, itemId, target) => viaStore((s, id) => s.moveCollectionItem(id, itemId, target))(col),
  root: (col, updates) => viaStore((s, id) => s.updateCollection(id, updates))(col),
};

const moduleDriver: Driver = {
  name: 'tree-edit',
  add: treeEdit.addItem,
  update: treeEdit.updateItem,
  remove: treeEdit.removeItem,
  move: treeEdit.moveItem,
  root: treeEdit.updateRoot,
};

const GUARD = { noauth: true };

function req(id: string, withBags = true): CollectionItem {
  const request: HttpRequest = {
    id: `${id}-req`,
    name: id,
    type: 'http',
    method: 'GET',
    url: 'https://example.com',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
  const item: CollectionItem = { id, name: id, type: 'request', request };
  return withBags ? Object.assign(item, { _oc: { n: id }, _postman: { ...GUARD } }) : item;
}

function folder(id: string, items: CollectionItem[]): CollectionItem {
  return Object.assign(
    { id, name: id, type: 'folder' as const, items },
    {
      _oc: { n: id },
      _postman: { ...GUARD },
    }
  );
}

/** F{ R1, Inner{ R2 } }, G{ R3 }, R4 — every node carries `_oc` and a guard marker. */
function fixture(): Collection {
  return Object.assign(
    {
      id: 'col',
      name: 'col',
      items: [
        folder('F', [req('R1'), folder('Inner', [req('R2')])]),
        folder('G', [req('R3')]),
        req('R4'),
      ],
      variables: [{ id: 'v1', key: 'a', value: '1', enabled: true }],
    },
    { _oc: { root: true }, _postman: { ...GUARD } }
  ) as Collection;
}

function find(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const i of items) {
    if (i.id === id) return i;
    const f = i.items ? find(i.items, id) : undefined;
    if (f) return f;
  }
  return undefined;
}

/** 'full' = _oc + guard, 'guard' = only the send-guard marker, 'none' = no bags. */
function bagState(node: object): 'full' | 'guard' | 'none' {
  const n = node as { _oc?: unknown; _postman?: unknown };
  if (n._oc !== undefined) return 'full';
  if (n._postman !== undefined) {
    expect(n._postman).toEqual(GUARD);
    return 'guard';
  }
  return 'none';
}

function states(col: Collection, ids: string[]): Record<string, string> {
  return Object.fromEntries(
    ids.map((id) => {
      const node = find(col.items, id);
      return [id, node ? bagState(node) : 'absent'];
    })
  );
}

const ALL = ['F', 'R1', 'Inner', 'R2', 'G', 'R3', 'R4'];

describe.each([storeDriver, moduleDriver])('tree-edit staleness via $name', (d) => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [], activeCollectionId: null });
  });

  describe('add', () => {
    it('root add leaves every existing bag intact', () => {
      const out = d.add(fixture(), req('N', false));
      expect(states(out, [...ALL, 'N'])).toEqual({
        F: 'full',
        R1: 'full',
        Inner: 'full',
        R2: 'full',
        G: 'full',
        R3: 'full',
        R4: 'full',
        N: 'none',
      });
    });

    it('nested add strips the target folder and its ancestors but keeps guard markers', () => {
      const out = d.add(fixture(), req('N', false), 'Inner');
      expect(states(out, [...ALL, 'N'])).toEqual({
        F: 'guard',
        R1: 'full',
        Inner: 'guard',
        R2: 'full',
        G: 'full',
        R3: 'full',
        R4: 'full',
        N: 'none',
      });
    });
  });

  describe('update', () => {
    it('non-auth edit strips the item and ancestors, keeping guard markers on all of them', () => {
      const out = d.update(fixture(), 'R2', { name: 'renamed' });
      expect(find(out.items, 'R2')?.name).toBe('renamed');
      expect(states(out, ALL)).toEqual({
        F: 'guard',
        R1: 'full',
        Inner: 'guard',
        R2: 'guard',
        G: 'full',
        R3: 'full',
        R4: 'full',
      });
    });

    it('own-auth edit drops the edited node markers but ancestors keep theirs', () => {
      const item = find(fixture().items, 'R2')!;
      const out = d.update(fixture(), 'R2', {
        request: { ...item.request!, auth: { type: 'bearer', bearer: { token: 't' } } } as never,
      });
      expect(states(out, ALL)).toEqual({
        F: 'guard',
        R1: 'full',
        Inner: 'guard',
        R2: 'none',
        G: 'full',
        R3: 'full',
        R4: 'full',
      });
    });

    it('folder own-auth edit drops that folder markers, ancestors keep theirs', () => {
      const out = d.update(fixture(), 'Inner', {
        auth: { type: 'bearer', bearer: { token: 't' } } as never,
      });
      expect(states(out, ALL)).toEqual({
        F: 'guard',
        R1: 'full',
        Inner: 'none',
        R2: 'full',
        G: 'full',
        R3: 'full',
        R4: 'full',
      });
    });

    it('value-identical re-save changes nothing on the path', () => {
      const out = d.update(fixture(), 'R2', { name: 'R2' });
      expect(states(out, ALL)).toEqual({
        F: 'full',
        R1: 'full',
        Inner: 'full',
        R2: 'full',
        G: 'full',
        R3: 'full',
        R4: 'full',
      });
    });

    it('unknown item id is a no-op', () => {
      const out = d.update(fixture(), 'missing', { name: 'x' });
      expect(states(out, ALL)).toEqual({
        F: 'full',
        R1: 'full',
        Inner: 'full',
        R2: 'full',
        G: 'full',
        R3: 'full',
        R4: 'full',
      });
    });
  });

  describe('remove', () => {
    it('strips ancestor folders (guard kept), not siblings', () => {
      const out = d.remove(fixture(), 'R2');
      expect(states(out, ALL)).toEqual({
        F: 'guard',
        R1: 'full',
        Inner: 'guard',
        R2: 'absent',
        G: 'full',
        R3: 'full',
        R4: 'full',
      });
    });

    it('root-level removal strips nothing', () => {
      const out = d.remove(fixture(), 'R4');
      expect(states(out, ALL)).toEqual({
        F: 'full',
        R1: 'full',
        Inner: 'full',
        R2: 'full',
        G: 'full',
        R3: 'full',
        R4: 'absent',
      });
    });
  });

  describe('move', () => {
    it('strips the moved node plus source and target ancestor chains (guard kept)', () => {
      const out = d.move(fixture(), 'R2', { parentId: 'G' });
      expect(find(out.items, 'G')?.items?.map((i) => i.id)).toEqual(['R3', 'R2']);
      expect(states(out, ALL)).toEqual({
        F: 'guard',
        R1: 'full',
        Inner: 'guard',
        R2: 'guard',
        G: 'guard',
        R3: 'full',
        R4: 'full',
      });
    });

    it('beforeId into another folder resolves the target chain from the post-move tree', () => {
      const out = d.move(fixture(), 'R4', { beforeId: 'R3' });
      expect(find(out.items, 'G')?.items?.map((i) => i.id)).toEqual(['R4', 'R3']);
      expect(states(out, ALL)).toEqual({
        F: 'full',
        R1: 'full',
        Inner: 'full',
        R2: 'full',
        G: 'guard',
        R3: 'full',
        R4: 'guard',
      });
    });

    it('cycle, same-parent and missing-target moves are no-ops that keep every bag', () => {
      for (const [id, target] of [
        ['F', { parentId: 'Inner' }],
        ['R1', { parentId: 'F' }],
        ['R1', { beforeId: 'missing' }],
        ['R1', { beforeId: 'R1' }],
        ['R1', { parentId: 'R4' }],
        ['missing', { parentId: 'G' }],
      ] as const) {
        const out = d.move(fixture(), id, target);
        expect(states(out, ALL), `${id} -> ${JSON.stringify(target)}`).toEqual({
          F: 'full',
          R1: 'full',
          Inner: 'full',
          R2: 'full',
          G: 'full',
          R3: 'full',
          R4: 'full',
        });
      }
    });
  });

  describe('root edits', () => {
    it('variables edit clears root _postman but keeps guard markers and root _oc', () => {
      const out = d.root(fixture(), {
        variables: [{ id: 'v2', key: 'b', value: '2', enabled: true }],
      });
      const root = out as unknown as { _oc?: unknown; _postman?: unknown };
      expect(root._oc).toEqual({ root: true });
      expect(root._postman).toEqual(GUARD);
    });

    it('root auth edit also drops the guard markers', () => {
      const out = d.root(fixture(), { auth: { type: 'bearer', bearer: { token: 't' } } as never });
      const root = out as unknown as { _oc?: unknown; _postman?: unknown };
      expect(root._oc).toEqual({ root: true });
      expect(root._postman).toBeUndefined();
    });

    it('script edit clears the root sidecar except guard markers', () => {
      const out = d.root(fixture(), { preRequestScript: 'x = 1' });
      expect((out as unknown as { _postman?: unknown })._postman).toEqual(GUARD);
    });

    it('a value-identical re-save leaves the root sidecar untouched', () => {
      const col = fixture();
      (col as unknown as { _postman: unknown })._postman = { noauth: true, scripts: ['keep'] };
      const out = d.root(col, { variables: structuredClone(col.variables) });
      expect((out as unknown as { _postman?: unknown })._postman).toEqual({
        noauth: true,
        scripts: ['keep'],
      });
    });

    it('a non-stale key (name) never touches the sidecar', () => {
      const col = fixture();
      (col as unknown as { _postman: unknown })._postman = { noauth: true, scripts: ['keep'] };
      const out = d.root(col, { name: 'renamed' });
      expect((out as unknown as { _postman?: unknown })._postman).toEqual({
        noauth: true,
        scripts: ['keep'],
      });
    });
  });
});

describe('purity of tree-edit', () => {
  it('never mutates its input', () => {
    const col = fixture();
    const snapshot = structuredClone(col);
    treeEdit.addItem(col, req('N', false), 'Inner');
    treeEdit.updateItem(col, 'R2', { name: 'x' });
    treeEdit.removeItem(col, 'R2');
    treeEdit.moveItem(col, 'R2', { parentId: 'G' });
    treeEdit.updateRoot(col, { variables: [] });
    expect(col).toEqual(snapshot);
  });
});

describe('duplicate', () => {
  it('drops every bag but keeps guard markers at every level, with fresh ids', () => {
    const src = fixture();
    const dup = duplicateCollection(src, []);
    expect(dup.id).not.toBe(src.id);
    expect((dup as unknown as { _oc?: unknown })._oc).toBeUndefined();
    expect((dup as unknown as { _postman?: unknown })._postman).toEqual(GUARD);
    expect(states(dup, [])).toEqual({});
    const ids = ['F', 'R1', 'Inner', 'R2', 'G', 'R3', 'R4'];
    for (const item of dup.items) {
      expect(ids).not.toContain(item.id);
      expect(bagState(item)).toBe('guard');
    }
    // Source untouched.
    expect(states(src, ALL)).toEqual(Object.fromEntries(ALL.map((id) => [id, 'full'])));
  });
});
