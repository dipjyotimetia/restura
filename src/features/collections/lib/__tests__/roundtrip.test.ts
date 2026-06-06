import { describe, it, expect } from 'vitest';
import { exportToPostman, exportToInsomnia } from '../exporters';
import { importPostmanCollection } from '../importers/postman';
import { importInsomniaCollection } from '../importers/insomnia';
import { validateImportedCollection } from '../importers/validateImported';
import type { Collection, CollectionItem, HttpRequest } from '@/types';

/**
 * Export → re-import regression net. The importers and exporters are
 * maintained independently; these tests catch silent drift (dropped auth,
 * lost folder nesting, script mangling) that unit tests on either side miss.
 * Equality is on salient fields — ids are regenerated on import by design.
 */

const httpRequest = (name: string, overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  id: `id-${name}`,
  name,
  type: 'http',
  method: 'POST',
  url: 'https://api.example.com/things',
  headers: [{ id: 'h1', key: 'X-Trace', value: '1', enabled: true }],
  params: [{ id: 'p1', key: 'page', value: '2', enabled: true }],
  body: { type: 'json', raw: '{"a":1}' },
  auth: { type: 'none' },
  ...overrides,
});

const fixture: Collection = {
  id: 'col-1',
  name: 'Round Trip',
  description: 'fixture',
  auth: { type: 'bearer', bearer: { token: 'col-token' } },
  preRequestScript: 'rs.variables.set("from", "collection");',
  testScript: 'rs.test("ok", function() {});',
  items: [
    {
      id: 'f1',
      name: 'Folder A',
      type: 'folder',
      auth: { type: 'basic', basic: { username: 'bob', password: 'pw' } },
      preRequestScript: 'rs.variables.set("from", "folder");',
      items: [
        {
          id: 'i1',
          name: 'Create thing',
          type: 'request',
          request: httpRequest('Create thing', {
            preRequestScript: 'rs.variables.set("x", "1");',
            testScript: 'rs.test("created", function() {});',
          }),
        },
      ],
    },
    {
      id: 'i2',
      name: 'List things',
      type: 'request',
      request: httpRequest('List things', {
        method: 'GET',
        body: { type: 'none' },
        auth: { type: 'api-key', apiKey: { key: 'X-Key', value: 'k-123', in: 'header' } },
      }),
    },
  ],
};

function findRequest(items: CollectionItem[], name: string): HttpRequest | undefined {
  for (const item of items) {
    if (item.type === 'request' && item.name === name) return item.request as HttpRequest;
    if (item.items) {
      const found = findRequest(item.items, name);
      if (found) return found;
    }
  }
  return undefined;
}

describe('Postman export → import round trip', () => {
  it('preserves structure, auth at every level, bodies, and scripts', async () => {
    const exported = exportToPostman(fixture);
    const reimported = await importPostmanCollection(exported);

    expect(validateImportedCollection(reimported)).toEqual({ ok: true });
    expect(reimported.name).toBe('Round Trip');
    expect(reimported.auth?.type).toBe('bearer');
    expect(reimported.auth?.bearer?.token).toBe('col-token');

    // Folder structure + folder auth survive.
    const folder = reimported.items.find((i) => i.type === 'folder');
    expect(folder?.name).toBe('Folder A');
    expect(folder?.auth?.type).toBe('basic');
    expect(folder?.auth?.basic).toEqual({ username: 'bob', password: 'pw' });

    // Nested request: method, url, headers, params, JSON body.
    const create = findRequest(reimported.items, 'Create thing');
    expect(create?.method).toBe('POST');
    expect(create?.url).toContain('https://api.example.com/things');
    expect(create?.headers.map((h) => [h.key, h.value])).toEqual([['X-Trace', '1']]);
    expect(create?.params.map((p) => [p.key, p.value])).toEqual([['page', '2']]);
    expect(create?.body).toEqual({ type: 'json', raw: '{"a":1}' });

    // Scripts round-trip through the rs.* ⇄ pm.* migration.
    expect(create?.preRequestScript).toContain('rs.variables.set("x", "1")');
    expect(create?.testScript).toContain('rs.test("created"');
    expect(reimported.preRequestScript).toContain('rs.variables.set("from", "collection")');
    expect(folder?.preRequestScript).toContain('rs.variables.set("from", "folder")');

    // Request-level auth survives.
    const list = findRequest(reimported.items, 'List things');
    expect(list?.auth.type).toBe('api-key');
    expect(list?.auth.apiKey).toEqual({ key: 'X-Key', value: 'k-123', in: 'header' });
  });
});

describe('Insomnia export → import round trip', () => {
  it('preserves structure, request auth, headers, params, and bodies', () => {
    const exported = exportToInsomnia(fixture);
    const { collection: reimported, warnings } = importInsomniaCollection(exported);

    expect(validateImportedCollection(reimported)).toEqual({ ok: true });
    expect(warnings).toEqual([]);
    expect(reimported.name).toBe('Round Trip');

    const folder = reimported.items.find((i) => i.type === 'folder');
    expect(folder?.name).toBe('Folder A');

    const create = findRequest(reimported.items, 'Create thing');
    expect(create?.method).toBe('POST');
    expect(create?.url).toBe('https://api.example.com/things');
    expect(create?.headers.map((h) => [h.key, h.value])).toEqual([['X-Trace', '1']]);
    expect(create?.params.map((p) => [p.key, p.value])).toEqual([['page', '2']]);
    expect(create?.body.type).toBe('json');
    expect(create?.body.raw).toBe('{"a":1}');

    const list = findRequest(reimported.items, 'List things');
    expect(list?.auth.type).toBe('api-key');
    expect(list?.auth.apiKey?.key).toBe('X-Key');
    expect(list?.auth.apiKey?.value).toBe('k-123');
  });
});
