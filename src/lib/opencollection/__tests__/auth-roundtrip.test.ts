import { describe, expect, it } from 'vitest';
import { SECRET_FIELDS_BY_AUTH_BLOCK } from '@/lib/shared/auth-secret-fields';
import type { AuthConfig, Collection, CollectionItem } from '@/types';
import { internalToOC } from '../from-internal';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from '../serializer';
import { ocToInternal } from '../to-internal';

/**
 * Local stand-in for the store's ADR-0007 SecretRef migration: wraps every
 * plaintext secret field in `{kind:'inline', value}`. (The real
 * `migrateAuthConfigToSecretRef` lives in a module that imports platform.ts,
 * which the CLI tsconfig — whose include glob covers this directory — can't
 * compile.)
 */
function wrapSecretsInline(a: AuthConfig): AuthConfig {
  const out = { ...a };
  for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
    const cur = out[block as keyof AuthConfig];
    if (!cur || typeof cur !== 'object') continue;
    const copy = { ...cur } as Record<string, unknown>;
    for (const f of fields) {
      if (typeof copy[f] === 'string') copy[f] = { kind: 'inline', value: copy[f] };
    }
    (out as unknown as Record<string, unknown>)[block as string] = copy;
  }
  return out;
}

/**
 * Collection-level and folder-level auth round-trip through the native OC
 * `request.auth` (RequestDefaults) fields — plus the staleness contract: an
 * in-app auth edit must defeat the cached `_oc` verbatim shortcut.
 */

const SOURCE_YAML = `opencollection: 1.0.0
info:
  name: Auth Demo
request:
  auth:
    type: bearer
    token: root-token
items:
  - info:
      name: Secure Folder
    request:
      auth:
        type: basic
        username: alice
        password: folder-pw
    items:
      - info:
          type: http
          name: Inner
        http:
          method: GET
          url: https://api.example.com/inner
  - info:
      type: http
      name: Top
    http:
      method: GET
      url: https://api.example.com/top
`;

/** Simulate the store's SecretRef migration that runs on persist (ADR-0007). */
function migrateLikeStore(collection: Collection): Collection {
  const migrateItems = (items: CollectionItem[]): CollectionItem[] =>
    items.map((item) => ({
      ...item,
      ...(item.auth ? { auth: wrapSecretsInline(item.auth) } : {}),
      ...(item.items ? { items: migrateItems(item.items) } : {}),
    }));
  return {
    ...collection,
    ...(collection.auth ? { auth: wrapSecretsInline(collection.auth) } : {}),
    items: migrateItems(collection.items),
  };
}

describe('OpenCollection collection/folder auth', () => {
  it('import populates collection.auth and folder item.auth', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = ocToInternal(oc);

    expect(internal.auth).toEqual({ type: 'bearer', bearer: { token: 'root-token' } });
    const folder = internal.items.find((i) => i.type === 'folder');
    expect(folder?.auth).toEqual({
      type: 'basic',
      basic: { username: 'alice', password: 'folder-pw' },
    });
  });

  it('import leaves auth unset when the document has none', () => {
    const oc = parseOpenCollectionYAML('opencollection: 1.0.0\ninfo:\n  name: Plain\nitems: []\n');
    const internal = ocToInternal(oc);
    expect(internal.auth).toBeUndefined();
  });

  it('round-trips byte-stable when nothing was edited (incl. SecretRef migration)', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = migrateLikeStore(ocToInternal(oc)) as Collection & { _oc?: unknown };
    // migrateLikeStore loses the _oc bags on folder spread? — items spread keeps
    // unknown props, collection spread keeps _oc. Verify shortcut still fires:
    const out = internalToOC(internal);
    expect(serializeOpenCollectionYAML(out)).toBe(serializeOpenCollectionYAML(oc));
  });

  it('edit-then-export: an edited collection auth reaches the output (no stale cache)', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = migrateLikeStore(ocToInternal(oc)) as Collection & { _oc?: unknown };
    internal.auth = { type: 'bearer', bearer: { token: { kind: 'inline', value: 'EDITED' } } };

    const out = internalToOC(internal);
    const request = out.request as { auth?: { type: string; token?: string } };
    expect(request.auth?.type).toBe('bearer');
    expect(request.auth?.token).toBe('EDITED');
    // Unedited folder auth still emits verbatim.
    const folder = (out.items as Array<{ request?: { auth?: { username?: string } } }>).find(
      (i) => i.request?.auth
    );
    expect(folder?.request?.auth?.username).toBe('alice');
  });

  it('edit-then-export: an edited folder auth reaches the output', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = migrateLikeStore(ocToInternal(oc)) as Collection & { _oc?: unknown };
    const folder = internal.items.find((i) => i.type === 'folder')!;
    folder.auth = { type: 'bearer', bearer: { token: { kind: 'inline', value: 'FOLDER-EDIT' } } };

    const out = internalToOC(internal);
    const outFolder = (out.items as Array<Record<string, unknown>>).find(
      (i) => (i.info as { name?: string })?.name === 'Secure Folder'
    );
    const auth = (outFolder?.request as { auth?: { type?: string; token?: string } })?.auth;
    expect(auth?.type).toBe('bearer');
    expect(auth?.token).toBe('FOLDER-EDIT');
    // Unedited child request inside the rebuilt folder still emits verbatim.
    const children = outFolder?.items as Array<Record<string, unknown>>;
    expect((children[0]?.info as { name?: string })?.name).toBe('Inner');
  });

  it('clearing collection auth removes it from the export', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = migrateLikeStore(ocToInternal(oc)) as Collection & { _oc?: unknown };
    delete internal.auth;
    const out = internalToOC(internal);
    expect(out.request).toBeUndefined();
  });

  it('from-scratch export (no _oc) emits collection + folder auth', () => {
    const internal: Collection = {
      id: 'c1',
      name: 'Native',
      auth: { type: 'bearer', bearer: { token: { kind: 'inline', value: 'tok' } } },
      items: [
        {
          id: 'f1',
          name: 'F',
          type: 'folder',
          auth: { type: 'basic', basic: { username: 'u', password: 'pw' } },
          items: [],
        },
      ],
    };
    const out = internalToOC(internal);
    expect((out.request as { auth?: { token?: string } }).auth?.token).toBe('tok');
    const folder = (out.items as Array<Record<string, unknown>>)[0]!;
    const fAuth = (folder.request as { auth?: { username?: string; password?: string } }).auth;
    expect(fAuth?.username).toBe('u');
    expect(fAuth?.password).toBe('pw');
  });

  it('keychain handles never leak plaintext — exported as {{handle:label}}', () => {
    const internal: Collection = {
      id: 'c1',
      name: 'Handles',
      auth: {
        type: 'bearer',
        bearer: { token: { kind: 'handle', id: 'h-1', label: 'prod token' } },
      },
      items: [],
    };
    const out = internalToOC(internal);
    const token = (out.request as { auth?: { token?: string } }).auth?.token;
    expect(token).toBe('{{handle:prod token}}');
  });
});
