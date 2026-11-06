import { describe, expect, it } from 'vitest';
import type { CollectionItem, HttpRequest } from '../../types';
import { exportPostmanV21 } from './export-v2';
import { importPostmanCollection } from './index';

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

describe('Postman v2 folder variables', () => {
  const source = {
    info: { name: 'C', schema: V21 },
    item: [
      {
        name: 'Folder',
        variable: [
          { key: 'region', value: 'eu' },
          { key: 'off', value: 'x', disabled: true },
        ],
        item: [{ name: 'R', request: { method: 'GET', url: 'https://{{region}}.api.dev' } }],
      },
    ],
  };

  it('maps folder-level variables onto the folder (not a sidecar warning)', () => {
    const { collection, report } = importPostmanCollection(source);
    const folder = collection.items[0] as CollectionItem;
    expect(folder.variables?.map((v) => [v.key, v.value, v.enabled])).toEqual([
      ['region', 'eu', true],
      ['off', 'x', false],
    ]);
    expect(
      report.warnings.some(
        (w) => w.kind === 'unmodelled-construct' && w.construct === 'item-variables'
      )
    ).toBe(false);
  });

  it('writes folder variables back on v2.1 export exactly once', () => {
    const { collection } = importPostmanCollection(source);
    const exported = exportPostmanV21(collection).collection as unknown as {
      item: Array<{ variable?: unknown[] }>;
    };
    expect(exported.item[0]?.variable).toEqual([
      { key: 'region', value: 'eu' },
      { key: 'off', value: 'x', disabled: true },
    ]);
  });
});

describe('Postman v2 path variables', () => {
  it('re-exports a baked path variable with its key', () => {
    const { collection } = importPostmanCollection({
      info: { name: 'C', schema: V21 },
      item: [
        {
          name: 'Get user',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.dev/users/:id',
              protocol: 'https',
              host: ['api', 'dev'],
              path: ['users', ':id'],
              variable: [{ key: 'id', value: '42', description: 'The user id' }],
            },
          },
        },
      ],
    });
    const exported = exportPostmanV21(collection).collection as unknown as {
      item: Array<{ request: { url: { variable?: Array<Record<string, unknown>> } } }>;
    };
    const variable = exported.item[0]?.request.url.variable;
    expect(variable).toBeDefined();
    for (const row of variable ?? []) expect(row.key).toBe('id');
  });

  it('keeps and re-exports v2.0 path variables keyed by `id`', () => {
    const { collection } = importPostmanCollection({
      info: {
        name: 'C',
        schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json',
      },
      item: [
        {
          name: 'Get user',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.dev/users/:id',
              variable: [{ id: 'id', value: '42', description: 'The user id' }],
            },
          },
        },
      ],
    });
    const request = collection.items[0]?.request as HttpRequest;
    expect(request.url).toBe('https://api.dev/users/:id');
    expect(request.pathVariables?.map((v) => [v.key, v.value, v.description])).toEqual([
      ['id', '42', 'The user id'],
    ]);
    const exported = exportPostmanV21(collection).collection as unknown as {
      item: Array<{ request: { url: { variable?: Array<Record<string, unknown>> } } }>;
    };
    const variable = exported.item[0]?.request.url.variable;
    expect(variable?.map((row) => [row.key, row.value])).toEqual([['id', '42']]);
  });
});
