// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { importPostmanCollection } from '../../shared/collections/postman';
import type { Collection, CollectionItem, HttpRequest } from '../../shared/types';

/**
 * A folder whose Postman auth Restura cannot sign (hawk, edgegrid, …) must
 * not let an ANCESTOR's credentials flow to the descendants that inherit from
 * it: Postman would have signed them with hawk, never with the collection's
 * bearer token. The importer gives such descendants an explicit `none` and a
 * report entry naming them (#1202).
 */

const BEARER = { type: 'bearer', bearer: [{ key: 'token', value: 'collection-secret' }] };

function find(items: CollectionItem[], name: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.name === name) return item;
    const hit = item.items ? find(item.items, name) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

function request(c: Collection, name: string): HttpRequest {
  return find(c.items, name)?.request as HttpRequest;
}

const v2 = {
  info: {
    name: 'V2',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: BEARER,
  item: [
    {
      name: 'Hawk folder',
      auth: { type: 'hawk', hawk: [{ key: 'authId', value: 'id' }] },
      item: [
        { name: 'Inherits', request: { method: 'GET', url: 'https://x/a' } },
        {
          name: 'Deeper',
          item: [{ name: 'Deep inherits', request: { method: 'GET', url: 'https://x/b' } }],
        },
        {
          name: 'Own basic',
          request: {
            method: 'GET',
            url: 'https://x/c',
            auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }] },
          },
        },
      ],
    },
    { name: 'Sibling', request: { method: 'GET', url: 'https://x/d' } },
  ],
};

const v3 = {
  $kind: 'collection',
  name: 'V3',
  auth: { type: 'bearer', credentials: [{ key: 'token', value: 'collection-secret' }] },
  items: [
    {
      $kind: 'collection',
      name: 'Hawk folder',
      auth: { type: 'hawk', credentials: [{ key: 'authId', value: 'id' }] },
      items: [
        { $kind: 'http-request', name: 'Inherits', method: 'GET', url: 'https://x/a' },
        {
          $kind: 'collection',
          name: 'Deeper',
          items: [
            { $kind: 'http-request', name: 'Deep inherits', method: 'GET', url: 'https://x/b' },
          ],
        },
      ],
    },
    { $kind: 'http-request', name: 'Sibling', method: 'GET', url: 'https://x/d' },
  ],
};

describe.each([
  ['v2.1', v2],
  ['v3', v3],
])('Postman %s: descendants of an unsupported-auth folder', (_label, doc) => {
  const { collection, report } = importPostmanCollection(doc);

  it('never inherit the collection credentials past the unsupported folder', () => {
    for (const name of ['Inherits', 'Deep inherits']) {
      const auth = request(collection, name).auth;
      expect(auth).toEqual({ type: 'none' });
      expect(JSON.stringify(auth)).not.toContain('collection-secret');
    }
  });

  it('report every inheriting descendant by name', () => {
    const names = report.warnings
      .filter((w) => w.kind === 'unsupported-auth' && w.authType === 'hawk')
      .map((w) => ('requestName' in w ? w.requestName : ''));
    expect(names).toEqual(expect.arrayContaining(['Hawk folder', 'Inherits', 'Deep inherits']));
  });

  it('keep the folder sidecar (so runners can refuse to send) and leave siblings alone', () => {
    const folder = find(collection.items, 'Hawk folder') as CollectionItem & {
      _postman?: { auth?: { type?: string } };
    };
    expect(folder._postman?.auth?.type).toBe('hawk');
    expect(request(collection, 'Sibling').auth.type).toBe('bearer');
  });
});

it('v2.1: a request with its own supported auth under the folder keeps it', () => {
  const { collection } = importPostmanCollection(v2);
  expect(request(collection, 'Own basic').auth.type).toBe('basic');
});
