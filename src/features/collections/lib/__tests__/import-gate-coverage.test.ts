import type { PostmanV21Collection } from '@shared/collections/postman';
import { describe, expect, it } from 'vitest';
import { importHoppscotchCollection } from '../importers/hoppscotch';
import { importInsomniaCollection } from '../importers/insomnia';
import { importOpenAPICollection } from '../importers/openapi';
import { importPostmanCollection, importPostmanV3Files } from '../importers/postman';
import type { ImportWarning } from '../importers/types';
import { validateImportedCollection } from '../importers/validateImported';

/**
 * Regression net for the import validation gate: every importer's output must
 * pass `validateImportedCollection`, INCLUDING for real-world inputs that
 * carry extension methods (PURGE, PROPFIND, LINK) or denied ones (TRACE).
 * Extension tokens are preserved verbatim (#857); only CONNECT/TRACE/TRACK and
 * non-token garbage downgrade to GET with a warning.
 */

describe('import gate coverage — extension methods survive, denied methods do not sink the import', () => {
  it('Postman: PURGE is preserved verbatim; gate passes', async () => {
    const postman: PostmanV21Collection = {
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
    expect(warnings.filter((w) => w.kind === 'unsupported-method')).toEqual([]);
    // The rest of the collection is untouched.
    expect(collection.items).toHaveLength(2);
    const purge = collection.items[0]!.request;
    const normal = collection.items[1]!.request;
    expect(purge && 'method' in purge && purge.method).toBe('PURGE');
    expect(normal && 'method' in normal && normal.method).toBe('POST');
  });

  it('Insomnia: PROPFIND is preserved verbatim; gate passes', () => {
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
    expect(warnings.filter((w) => w.kind === 'unsupported-method')).toEqual([]);
    const req = collection.items[0]!.request;
    expect(req && 'method' in req && req.method).toBe('PROPFIND');
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

  it('Hoppscotch: a custom method (LINK) is preserved verbatim; gate passes', () => {
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
    expect(warnings.filter((w) => w.kind === 'unsupported-method')).toEqual([]);
    const req = collection.items[0]!.request;
    expect(req && 'method' in req && req.method).toBe('LINK');
  });
});

describe('import gate coverage — representative clean fixtures pass', () => {
  it('Postman with folders, auth, scripts, bodies, params passes the gate', async () => {
    const postman: PostmanV21Collection = {
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

describe('import gate coverage — Postman v3', () => {
  const v3 = (items: unknown[]) => ({ $kind: 'collection', name: 'Postman v3', items });
  const methods = (items: Array<{ request?: unknown }>) =>
    items.map((i) => (i.request as { method?: string } | undefined)?.method);

  it('extension methods survive verbatim; gate passes', async () => {
    const warnings: ImportWarning[] = [];
    const collection = await importPostmanCollection(
      v3([
        { $kind: 'http-request', name: 'Purge', method: 'PURGE', url: 'https://cdn.example.com' },
        { $kind: 'http-request', name: 'Find', method: 'PROPFIND', url: 'https://dav.example.com' },
        { $kind: 'http-request', name: 'Link', method: 'LINK', url: 'https://api.example.com' },
      ]),
      warnings
    );
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
    expect(warnings.filter((w) => w.kind === 'unsupported-method')).toEqual([]);
    expect(methods(collection.items)).toEqual(['PURGE', 'PROPFIND', 'LINK']);
  });

  it('CONNECT / TRACE downgrade to GET with a warning; gate passes', async () => {
    const warnings: ImportWarning[] = [];
    const collection = await importPostmanCollection(
      v3([
        { $kind: 'http-request', name: 'Tunnel', method: 'CONNECT', url: 'https://x' },
        { $kind: 'http-request', name: 'Trace', method: 'TRACE', url: 'https://x' },
      ]),
      warnings
    );
    expect(validateImportedCollection(collection)).toEqual({ ok: true });
    expect(warnings.filter((w) => w.kind === 'unsupported-method')).toEqual([
      { kind: 'unsupported-method', method: 'CONNECT', requestName: 'Tunnel' },
      { kind: 'unsupported-method', method: 'TRACE', requestName: 'Trace' },
    ]);
    expect(methods(collection.items)).toEqual(['GET', 'GET']);
  });

  it('every $kind and a YAML folder pass the gate', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const allKinds = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'shared/collections/postman/__fixtures__/v3/all-kinds.json'),
        'utf8'
      )
    );
    expect(validateImportedCollection(await importPostmanCollection(allKinds))).toEqual({
      ok: true,
    });
    const folder = importPostmanV3Files({
      'Demo/.resources/definition.yaml': '$kind: collection\nname: Demo\n',
      'Demo/Get.request.yaml': '$kind: http-request\nurl: https://x/y?a=1\nmethod: get\norder: 1\n',
    });
    expect(folder.detectedVersion).toBe('3.0');
    expect(validateImportedCollection(folder.collection)).toEqual({ ok: true });
  });
});
