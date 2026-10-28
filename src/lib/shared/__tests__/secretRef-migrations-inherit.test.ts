import {
  exportPostmanV3Tree,
  exportPostmanV21,
  importPostmanCollection,
} from '@shared/collections/postman';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig, Collection, CollectionItem } from '@/types';

/**
 * #1226: desktop handle conversion must not turn an inheriting Postman request
 * into an explicit, blank-secret auth block on export. The importer bakes the
 * nearest ancestor's auth into the request; conversion reuses the ancestor's
 * handle for a request whose WHOLE auth is identical to that ancestor's, so
 * `sameAuth` still sees inheritance.
 */

type Raw = Record<string, unknown>;

async function loadConverter() {
  vi.resetModules();
  let n = 0;
  const store = vi.fn(async (_args: { value: string; label: string }) => ({
    ok: true as const,
    id: `h-${++n}`,
  }));
  vi.doMock('../platform', () => ({
    isElectron: () => true,
    getElectronAPI: () => ({ secrets: { store } }),
  }));
  const { convertCollectionSecretsToHandles } = await import('../secretRef-migrations');
  return { convertCollectionSecretsToHandles, store };
}

afterEach(() => {
  vi.doUnmock('../platform');
});

const bearer = (token: string) => ({
  type: 'bearer',
  bearer: [{ key: 'token', value: token, type: 'string' }],
});

function v21(auth: unknown, item: unknown[]): Raw {
  return {
    info: {
      name: 'Col',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    ...(auth ? { auth } : {}),
    item,
  };
}

const req = (name: string, auth?: unknown) => ({
  name,
  request: { method: 'GET', url: 'https://api.example.com/x', ...(auth ? { auth } : {}) },
});

function findIn(items: CollectionItem[], name: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.name === name) return item;
    const hit = item.items ? findIn(item.items, name) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

function find(items: CollectionItem[], name: string): CollectionItem {
  const hit = findIn(items, name);
  if (!hit) throw new Error(`no item ${name}`);
  return hit;
}

function findRaw(items: unknown, name: string): Raw {
  for (const item of (items as Raw[]) ?? []) {
    if (item.name === name) return item;
    const nested = item.items ?? item.item;
    if (nested) {
      try {
        return findRaw(nested, name);
      } catch {
        /* keep looking */
      }
    }
  }
  throw new Error(`no raw item ${name}`);
}

const requestAuth = (c: Collection, name: string) =>
  (find(c.items, name).request as { auth: AuthConfig }).auth;
const tokenOf = (auth: AuthConfig | undefined) => auth?.bearer?.token;

describe('convertCollectionSecretsToHandles keeps Postman inheritance (#1226)', () => {
  it('collection auth: the inheriting request round-trips as inherit (v3 and v2.1)', async () => {
    const { convertCollectionSecretsToHandles, store } = await loadConverter();
    const { collection } = importPostmanCollection(v21(bearer('tok-col'), [req('Inherits')]));

    const converted = await convertCollectionSecretsToHandles(collection);

    // One credential, one keychain entry, shared by collection and request.
    expect(store).toHaveBeenCalledTimes(1);
    expect(tokenOf(requestAuth(converted, 'Inherits'))).toEqual(tokenOf(converted.auth));
    expect(tokenOf(converted.auth)).toMatchObject({ kind: 'handle', id: 'h-1' });

    // v3: the request omits `auth` (= inherit), it is not an explicit blank block.
    const { tree } = exportPostmanV3Tree(converted);
    expect(findRaw(tree.items, 'Inherits').auth).toBeUndefined();
    // Re-import: the request still inherits the collection auth.
    const back = importPostmanCollection(tree).collection;
    expect(requestAuth(back, 'Inherits')).toEqual(back.auth);

    // v2.1 delegates to the same rule.
    const v2 = exportPostmanV21(converted).collection as unknown as Raw;
    expect((findRaw(v2.item, 'Inherits').request as Raw).auth).toBeUndefined();
    const back2 = importPostmanCollection(v2).collection;
    expect(requestAuth(back2, 'Inherits')).toEqual(back2.auth);
  });

  it('reuses the NEAREST ancestor (folder), never a further one', async () => {
    const { convertCollectionSecretsToHandles } = await loadConverter();
    const { collection } = importPostmanCollection(
      v21(bearer('tok-col'), [
        { name: 'F', auth: bearer('tok-folder'), item: [req('InFolder')] },
        req('AtRoot'),
      ])
    );

    const converted = await convertCollectionSecretsToHandles(collection);
    const folder = find(converted.items, 'F');

    expect(tokenOf(requestAuth(converted, 'InFolder'))).toEqual(tokenOf(folder.auth));
    expect(tokenOf(requestAuth(converted, 'AtRoot'))).toEqual(tokenOf(converted.auth));
    expect(tokenOf(folder.auth)).not.toEqual(tokenOf(converted.auth));

    const { tree } = exportPostmanV3Tree(converted);
    expect(findRaw(tree.items, 'InFolder').auth).toBeUndefined();
    expect(findRaw(tree.items, 'AtRoot').auth).toBeUndefined();
  });

  it('a request with its own, different credential keeps its own handle and exports explicitly', async () => {
    const { convertCollectionSecretsToHandles } = await loadConverter();
    const { collection } = importPostmanCollection(
      v21(bearer('tok-col'), [req('Own', bearer('tok-own'))])
    );

    const converted = await convertCollectionSecretsToHandles(collection);

    expect(tokenOf(requestAuth(converted, 'Own'))).not.toEqual(tokenOf(converted.auth));
    const { tree } = exportPostmanV3Tree(converted);
    expect(findRaw(tree.items, 'Own').auth).toMatchObject({ type: 'bearer' });
  });

  it('only a WHOLE-config match shares: same secret, different api-key name stays distinct', async () => {
    const { convertCollectionSecretsToHandles } = await loadConverter();
    const apikey = (key: string) => ({
      type: 'apikey',
      apikey: [
        { key: 'key', value: key },
        { key: 'value', value: 'same-secret' },
        { key: 'in', value: 'header' },
      ],
    });
    const { collection } = importPostmanCollection(
      v21(apikey('X-Col'), [req('Other', apikey('X-Req'))])
    );

    const converted = await convertCollectionSecretsToHandles(collection);
    const own = requestAuth(converted, 'Other').apiKey?.value;

    expect(own).toMatchObject({ kind: 'handle' });
    expect(own).not.toEqual(converted.auth?.apiKey?.value);
  });

  it('never dedupes across siblings (no ancestor auth)', async () => {
    const { convertCollectionSecretsToHandles } = await loadConverter();
    const { collection } = importPostmanCollection(
      v21(undefined, [req('A', bearer('same')), req('B', bearer('same'))])
    );

    const converted = await convertCollectionSecretsToHandles(collection);

    expect(tokenOf(requestAuth(converted, 'A'))).not.toEqual(tokenOf(requestAuth(converted, 'B')));
  });

  it('an explicit-noauth folder cuts the chain: no reuse of the collection handle below it', async () => {
    const { convertCollectionSecretsToHandles } = await loadConverter();
    const { collection } = importPostmanCollection(
      v21(bearer('tok-col'), [
        { name: 'F', auth: { type: 'noauth' }, item: [req('Below', bearer('tok-col'))] },
      ])
    );

    const converted = await convertCollectionSecretsToHandles(collection);

    expect(tokenOf(requestAuth(converted, 'Below'))).toMatchObject({ kind: 'handle' });
    expect(tokenOf(requestAuth(converted, 'Below'))).not.toEqual(tokenOf(converted.auth));
  });

  it('web is a no-op', async () => {
    vi.resetModules();
    vi.doMock('../platform', () => ({ isElectron: () => false, getElectronAPI: () => undefined }));
    const { convertCollectionSecretsToHandles } = await import('../secretRef-migrations');
    const { collection } = importPostmanCollection(v21(bearer('tok-col'), [req('Inherits')]));
    expect(await convertCollectionSecretsToHandles(collection)).toBe(collection);
  });
});
