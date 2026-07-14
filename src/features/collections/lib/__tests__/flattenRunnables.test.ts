import { describe, expect, it } from 'vitest';
import type { AuthConfig, CollectionItem, HttpRequest } from '@/types';
import { flattenRunnables } from '../flattenRunnables';

function req(id: string, name: string, pre?: string, test?: string): CollectionItem {
  const request: HttpRequest = {
    id,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...(pre ? { preRequestScript: pre } : {}),
    ...(test ? { testScript: test } : {}),
  };
  return { id, name, type: 'request', request };
}

describe('flattenRunnables — effective script combining', () => {
  it('combines collection -> folder -> request pre-request scripts in order', () => {
    const items: CollectionItem[] = [
      {
        id: 'f1',
        name: 'Folder',
        type: 'folder',
        preRequestScript: 'FOLDER_PRE',
        items: [req('r1', 'Req', 'REQUEST_PRE')],
      },
    ];
    const runnables = flattenRunnables(items, undefined, { preRequestScript: 'COLLECTION_PRE' });
    expect(runnables).toHaveLength(1);
    expect(runnables[0]!.request.preRequestScript).toBe('COLLECTION_PRE\nFOLDER_PRE\nREQUEST_PRE');
  });

  it('combines test scripts parent-to-child as well', () => {
    const items: CollectionItem[] = [
      {
        id: 'f1',
        name: 'F',
        type: 'folder',
        testScript: 'FOLDER_TEST',
        items: [req('r1', 'R', undefined, 'REQ_TEST')],
      },
    ];
    const runnables = flattenRunnables(items, undefined, { testScript: 'COLLECTION_TEST' });
    expect(runnables[0]!.request.testScript).toBe('COLLECTION_TEST\nFOLDER_TEST\nREQ_TEST');
  });

  it('leaves a request script untouched when there are no ancestor scripts', () => {
    const runnables = flattenRunnables([req('r1', 'R', 'ONLY_REQ')]);
    expect(runnables[0]!.request.preRequestScript).toBe('ONLY_REQ');
    expect(runnables[0]!.request.testScript).toBeUndefined();
  });

  it('applies ancestor folder scripts when running a nested folder subtree', () => {
    const items: CollectionItem[] = [
      {
        id: 'outer',
        name: 'Outer',
        type: 'folder',
        preRequestScript: 'OUTER_PRE',
        items: [
          {
            id: 'inner',
            name: 'Inner',
            type: 'folder',
            preRequestScript: 'INNER_PRE',
            items: [req('r1', 'R', 'REQ_PRE')],
          },
        ],
      },
    ];
    const runnables = flattenRunnables(items, 'inner', { preRequestScript: 'COLLECTION_PRE' });
    expect(runnables).toHaveLength(1);
    expect(runnables[0]!.request.preRequestScript).toBe(
      'COLLECTION_PRE\nOUTER_PRE\nINNER_PRE\nREQ_PRE'
    );
    expect(runnables[0]!.folderPath).toEqual(['Outer', 'Inner']);
  });

  it('returns [] for an unknown folder id', () => {
    expect(flattenRunnables([req('r1', 'R')], 'missing')).toEqual([]);
  });
});

describe('flattenRunnables — inherited auth threading', () => {
  const collectionAuth: AuthConfig = { type: 'bearer', bearer: { token: 'COLLECTION' } };
  const folderAuth: AuthConfig = { type: 'bearer', bearer: { token: 'FOLDER' } };
  const innerAuth: AuthConfig = { type: 'bearer', bearer: { token: 'INNER' } };

  function folder(id: string, items: CollectionItem[], auth?: AuthConfig): CollectionItem {
    return { id, name: id, type: 'folder', items, ...(auth ? { auth } : {}) };
  }

  it('threads the collection-level auth to root requests', () => {
    const runnables = flattenRunnables([req('r1', 'R')], undefined, undefined, collectionAuth);
    expect(runnables[0]!.inheritedAuth).toEqual(collectionAuth);
  });

  it('nearest ancestor folder auth wins over collection auth', () => {
    const items = [folder('f1', [req('r1', 'R')], folderAuth)];
    const runnables = flattenRunnables(items, undefined, undefined, collectionAuth);
    expect(runnables[0]!.inheritedAuth).toEqual(folderAuth);
  });

  it('inner folder auth overrides outer folder auth', () => {
    const items = [folder('outer', [folder('inner', [req('r1', 'R')], innerAuth)], folderAuth)];
    const runnables = flattenRunnables(items, undefined, undefined, collectionAuth);
    expect(runnables[0]!.inheritedAuth).toEqual(innerAuth);
  });

  it('a folder without auth passes the ancestor auth through', () => {
    const items = [folder('outer', [folder('inner', [req('r1', 'R')])], folderAuth)];
    const runnables = flattenRunnables(items, undefined, undefined, collectionAuth);
    expect(runnables[0]!.inheritedAuth).toEqual(folderAuth);
  });

  it("a folder with auth.type 'none' does not mask the ancestor auth", () => {
    const items = [folder('f1', [req('r1', 'R')], { type: 'none' })];
    const runnables = flattenRunnables(items, undefined, undefined, collectionAuth);
    expect(runnables[0]!.inheritedAuth).toEqual(collectionAuth);
  });

  it('a folder run inherits auth from folders above the target', () => {
    const items = [folder('outer', [folder('inner', [req('r1', 'R')])], folderAuth)];
    const runnables = flattenRunnables(items, 'inner', undefined, collectionAuth);
    expect(runnables[0]!.inheritedAuth).toEqual(folderAuth);
  });

  it('inheritedAuth is undefined when nothing applies', () => {
    expect(flattenRunnables([req('r1', 'R')])[0]!.inheritedAuth).toBeUndefined();
  });
});
