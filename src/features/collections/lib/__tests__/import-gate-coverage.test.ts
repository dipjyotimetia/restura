import { describe, it, expect } from 'vitest';
import { importPostmanCollection } from '../importers/postman';
import { importInsomniaCollection } from '../importers/insomnia';
import { importOpenAPICollection } from '../importers/openapi';
import { importHoppscotchCollection } from '../importers/hoppscotch';
import { validateImportedCollection } from '../importers/validateImported';
import type { ImportWarning } from '../importers/types';
import type { PostmanCollection } from '@/types';

/**
 * Regression net for the import validation gate: every importer's output must
 * pass `validateImportedCollection`, INCLUDING for real-world inputs that
 * carry methods outside Restura's HttpMethod union (PURGE, PROPFIND, TRACE).
 * Before method coercion landed, any one of these rejected the entire import.
 */

describe('import gate coverage — out-of-union methods do not sink the import', () => {
  it('Postman: PURGE downgrades to GET with a warning; gate passes', async () => {
    const postman: PostmanCollection = {
      info: {
        name: 'Varnish Tools',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'Purge cache',
          request: { method: 'PURGE', header: [], url: 'https://cdn.example.com/page' },
        },
        {
          name: 'Normal request',
          request: { method: 'POST', header: [], url: 'https://api.example.com/x' },
        },
      ],
    };
    const warnings: ImportWarning[] = [];
    const collection = await importPostmanCollection(postman, warnings);

    expect(validateImportedCollection(collection)).toEqual({ ok: true });
    expect(warnings).toContainEqual({
      kind: 'unsupported-method',
      method: 'PURGE',
      requestName: 'Purge cache',
    });
    // The rest of the collection is untouched.
    expect(collection.items).toHaveLength(2);
    const purge = collection.items[0]!.request;
    const normal = collection.items[1]!.request;
    expect(purge && 'method' in purge && purge.method).toBe('GET');
    expect(normal && 'method' in normal && normal.method).toBe('POST');
  });

  it('Insomnia: PROPFIND downgrades to GET with a warning; gate passes', () => {
    const { collection, warnings } = importInsomniaCollection({
      _type: 'export',
      __export_format: 4,
      __export_source: 'insomnia.desktop.app',
      resources: [
        { _id: 'wrk_1', _type: 'workspace', name: 'WebDAV' },
        {
          _id: 'req_1',
          _type: 'request',
          name: 'List folder',
          method: 'PROPFIND',
          url: 'https://dav.example.com/files',
          parentId: 'wrk_1',
        },
      ],
    });
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
    expect(warnings).toContainEqual({
      kind: 'unsupported-method',
      method: 'PROPFIND',
      requestName: 'List folder',
    });
  });

  it('OpenAPI: a trace operation downgrades to GET with a warning; gate passes', async () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Tracing API', version: '1.0.0' },
      paths: {
        '/debug': {
          trace: { operationId: 'traceDebug', responses: { '200': { description: 'ok' } } },
          get: { operationId: 'getDebug', responses: { '200': { description: 'ok' } } },
        },
      },
    };
    const warnings: ImportWarning[] = [];
    const collection = await importOpenAPICollection(spec, warnings);
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
    expect(warnings.some((w) => w.kind === 'unsupported-method' && w.method === 'TRACE')).toBe(
      true
    );
  });

  it('Hoppscotch: a custom method downgrades to GET with a warning; gate passes', () => {
    const { collection, warnings } = importHoppscotchCollection({
      v: 6,
      name: 'Custom methods',
      folders: [],
      requests: [
        {
          v: '11',
          name: 'Link resource',
          method: 'LINK',
          endpoint: 'https://api.example.com/link',
          headers: [],
          params: [],
          preRequestScript: '',
          testScript: '',
        },
      ],
    });
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
    expect(warnings).toContainEqual({
      kind: 'unsupported-method',
      method: 'LINK',
      requestName: 'Link resource',
    });
  });
});

describe('import gate coverage — representative clean fixtures pass', () => {
  it('Postman with folders, auth, scripts, bodies, params passes the gate', async () => {
    const postman: PostmanCollection = {
      info: {
        name: 'Full-shape',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      auth: {
        type: 'bearer',
        bearer: [{ key: 'token', value: 't', type: 'string' }],
      },
      item: [
        {
          name: 'Folder',
          item: [
            {
              name: 'Create',
              request: {
                method: 'POST',
                header: [{ key: 'X-A', value: '1' }],
                url: 'https://api.example.com/things?page=2',
                body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
              },
              event: [
                {
                  listen: 'test',
                  script: { type: 'text/javascript', exec: ['pm.test("ok", () => {});'] },
                },
              ],
            },
          ],
        },
      ],
    };
    const collection = await importPostmanCollection(postman);
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
  });

  it('Insomnia v4 with auth and bodies passes the gate', () => {
    const { collection } = importInsomniaCollection({
      _type: 'export',
      __export_format: 4,
      __export_source: 'insomnia.desktop.app',
      resources: [
        { _id: 'wrk_1', _type: 'workspace', name: 'WS' },
        { _id: 'fld_1', _type: 'request_group', name: 'Group', parentId: 'wrk_1' },
        {
          _id: 'req_1',
          _type: 'request',
          name: 'Login',
          method: 'POST',
          url: 'https://api.example.com/login',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          body: { mimeType: 'application/json', text: '{"u":"x"}' },
          authentication: { type: 'basic', username: 'u', password: 'p' },
          parentId: 'fld_1',
        },
      ],
    });
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
  });

  it('OpenAPI 3.0 spec with params and request bodies passes the gate', async () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Pets', version: '1.0.0' },
      servers: [{ url: 'https://petstore.example.com/v1' }],
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
          post: {
            operationId: 'updatePet',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } } },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const collection = await importOpenAPICollection(spec);
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
  });
});
