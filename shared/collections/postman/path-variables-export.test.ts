import { describe, expect, it } from 'vitest';
import type { Collection, HttpRequest, KeyValue } from '../../types';
import { exportPostmanV21 } from './export-v2';
import { exportPostmanV3 } from './export-v3';
import { importPostmanCollection, importPostmanV3Files } from './index';

/**
 * A request authored in Restura (no import sidecar) keeps its path variables
 * through a Postman export → import: `url.variable` (v2.1) / `pathVariables`
 * (v3) are written from the typed rows, and the URL keeps its `:name`.
 */

const pathVariables: KeyValue[] = [
  { id: 'a', key: 'id', value: '{{userId}}', enabled: true, description: 'The user' },
  { id: 'b', key: 'tab', value: 'posts', enabled: false },
];

const request: HttpRequest = {
  id: 'r',
  name: 'Get user',
  type: 'http',
  method: 'GET',
  url: 'https://api.test/users/:id/:tab',
  headers: [],
  params: [],
  pathVariables,
  body: { type: 'none' },
  auth: { type: 'none' },
};

const collection: Collection = {
  id: 'c',
  name: 'C',
  items: [{ id: 'i', name: 'Get user', type: 'request', request }],
};

const rows = (r: HttpRequest | undefined) =>
  r?.pathVariables?.map(({ key, value, enabled, description }) => ({
    key,
    value,
    enabled,
    description,
  }));
const expected = pathVariables.map(({ key, value, enabled, description }) => ({
  key,
  value,
  enabled,
  description,
}));

describe('Postman export of path variables', () => {
  it('v2.1 writes url.variable from the rows and re-imports them', () => {
    const out = exportPostmanV21(collection).collection as unknown as {
      item: Array<{ request: { url: { raw: string; variable?: unknown[] } } }>;
    };
    const url = out.item[0]?.request.url;
    expect(url?.raw).toBe('https://api.test/users/:id/:tab');
    expect(url?.variable).toEqual([
      { key: 'id', value: '{{userId}}', description: 'The user' },
      { key: 'tab', value: 'posts', disabled: true },
    ]);
    const again = importPostmanCollection(out).collection.items[0]?.request as HttpRequest;
    expect(again.url).toBe('https://api.test/users/:id/:tab');
    expect(rows(again)).toEqual(expected);
  });

  it('v3 writes pathVariables from the rows and re-imports them', () => {
    const { files } = exportPostmanV3(collection);
    const wrapped = Object.fromEntries(Object.entries(files).map(([p, t]) => [`C/${p}`, t]));
    const again = importPostmanV3Files(wrapped).collection.items[0]?.request as HttpRequest;
    expect(again.url).toBe('https://api.test/users/:id/:tab');
    expect(rows(again)).toEqual(expected);
  });

  it('a secret row is written empty and reported', () => {
    const secret: Collection = {
      ...collection,
      items: [
        {
          id: 'i',
          name: 'Get user',
          type: 'request',
          request: {
            ...request,
            pathVariables: [{ id: 's', key: 'id', value: 'S3CRET', enabled: true, secret: true }],
          },
        },
      ],
    };
    const { collection: out, report } = exportPostmanV21(secret);
    expect(JSON.stringify(out)).not.toContain('S3CRET');
    expect(JSON.stringify(report)).toContain('secret-variable');
  });
});
