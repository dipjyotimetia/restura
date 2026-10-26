import { describe, expect, it } from 'vitest';
import type { CollectionItem, HttpRequest } from '../../types';
import { authParamsV2, convertPostmanAuth, unmappedAuthRemainder } from './auth';
import { importPostmanCollection } from './index';
import { getPostmanSidecar } from './sidecar';

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function req(item: CollectionItem | undefined): HttpRequest {
  return item?.request as HttpRequest;
}

function withRequest(request: unknown, extra: Record<string, unknown> = {}) {
  return importPostmanCollection({
    info: { name: 'C', schema: V21 },
    item: [{ name: 'R', request, ...extra }],
  });
}

describe('convertPostmanAuth — typed mappings', () => {
  const p = (o: Record<string, string>) => new Map(Object.entries(o));

  it.each([
    [
      'basic',
      { username: 'u', password: 'p' },
      { type: 'basic', basic: { username: 'u', password: 'p' } },
    ],
    ['bearer', { token: 't' }, { type: 'bearer', bearer: { token: 't' } }],
    [
      'apikey',
      { key: 'X-Key', value: 'v', in: 'query' },
      { type: 'api-key', apiKey: { key: 'X-Key', value: 'v', in: 'query' } },
    ],
    ['apikey', { key: 'k' }, { type: 'api-key', apiKey: { key: 'k', value: '', in: 'header' } }],
    [
      'digest',
      { username: 'u', password: 'p' },
      { type: 'digest', digest: { username: 'u', password: 'p' } },
    ],
    [
      'awsv4',
      { accessKey: 'a', secretKey: 's', region: 'r', service: 'x' },
      {
        type: 'aws-signature',
        awsSignature: { accessKey: 'a', secretKey: 's', region: 'r', service: 'x' },
      },
    ],
    ['noauth', {}, { type: 'none' }],
  ])('%s', (type, params, auth) => {
    expect(convertPostmanAuth(type, p(params))).toEqual({ status: 'ok', auth });
  });

  it('inherit and empty type defer to the parent', () => {
    expect(convertPostmanAuth('inherit', p({}))).toEqual({ status: 'inherit' });
    expect(convertPostmanAuth('', p({}))).toEqual({ status: 'inherit' });
  });

  it.each([
    ['client_credentials', 'client_credentials'],
    ['password_credentials', 'password'],
    ['authorization_code', 'authorization_code'],
    ['something-else', undefined],
  ])('oauth2 grant_type %s → %s', (grant, expected) => {
    const r = convertPostmanAuth('oauth2', p({ grant_type: grant }));
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.auth.oauth2?.grantType).toBe(expected);
  });

  it('oauth1 approximations: privateKey or body/URL placement', () => {
    expect(convertPostmanAuth('oauth1', p({ privateKey: 'k' })).status).toBe('approximated');
    expect(convertPostmanAuth('oauth1', p({ addParamsToHeader: 'false' })).status).toBe(
      'approximated'
    );
    expect(convertPostmanAuth('oauth1', p({ addParamsToHeader: 'true' })).status).toBe('ok');
  });

  it('authParamsV2 stringifies scalars, ignores objects and keyless entries', () => {
    expect([
      ...authParamsV2([
        { key: 'a', value: 1 },
        { key: 'b', value: true },
        { key: 'c', value: { nested: 1 } },
        { key: 'd' },
        { value: 'no-key' },
        null,
      ]),
    ]).toEqual([
      ['a', '1'],
      ['b', 'true'],
      ['c', ''],
      ['d', ''],
    ]);
    expect([...authParamsV2('garbage')]).toEqual([]);
  });

  it('unmappedAuthRemainder drops mapped keys in v2.0 object maps and keeps unsupported blocks', () => {
    expect(
      unmappedAuthRemainder({
        type: 'oauth2',
        oauth2: { clientSecret: 's', grant_type: 'implicit' },
      })
    ).toEqual({ type: 'oauth2', oauth2: { grant_type: 'implicit' } });
    const hawk = { type: 'hawk', hawk: { authKey: 'k' } };
    expect(unmappedAuthRemainder({ ...hawk, bearer: [{ key: 'token', value: 't' }] })).toEqual(
      hawk
    );
  });
});

describe('parsePostmanV2 — request shapes', () => {
  it('rejects non-object input', () => {
    expect(() => importPostmanCollection(null)).toThrow(/JSON object/);
    expect(() => importPostmanCollection([])).toThrow(/JSON object/);
  });

  it('defaults names, skips non-object items and items without a request', () => {
    const { collection } = importPostmanCollection({
      info: {},
      item: [null, 'x', { name: 'no-request' }, { request: 'https://a.example.com/p?x=1#frag' }],
    });
    expect(collection.name).toBe('Imported Collection');
    expect(collection.items).toHaveLength(1);
    const r = req(collection.items[0]);
    expect(collection.items[0]!.name).toBe('Unnamed Request');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://a.example.com/p#frag');
    expect(r.params.map((q) => [q.key, q.value])).toEqual([['x', '1']]);
  });

  it('keeps an unsendable method in the sidecar', () => {
    const { collection } = withRequest({ method: 'TRACE', url: 'https://x.example.com' });
    expect(getPostmanSidecar(collection.items[0]!)?.method).toBe('TRACE');
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'auth type %s is unsupported, never an inherited property',
    (type) => {
      const auth = JSON.parse(`{"type":"${type}"}`);
      const { collection, report } = withRequest({ url: 'https://x.example.com', auth });
      expect(req(collection.items[0]).auth).toEqual({ type: 'none' });
      expect(report.warnings).toEqual([
        { kind: 'unsupported-auth', authType: type, requestName: 'R' },
      ]);
      expect(getPostmanSidecar(collection.items[0]!)?.auth).toEqual({ type });
    }
  );

  it('reports an unrecognised schema version and an unsendable method', () => {
    const { report, collection } = importPostmanCollection({
      info: {
        name: 'C',
        schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json',
      },
      item: [{ name: 'R', request: { method: 'CONNECT', url: 'https://x.example.com' } }],
    });
    expect(report.sourceVersion).toBe('2.1');
    expect(report.warnings).toEqual([
      { kind: 'schema-version', format: 'Postman', version: '1.0', note: expect.any(String) },
      { kind: 'unsupported-method', method: 'CONNECT', requestName: 'R' },
    ]);
    expect(req(collection.items[0]).method).toBe('GET');
  });

  it('parses a raw "Key: Value" header block and structured description objects', () => {
    const { collection } = withRequest({
      url: 'https://x.example.com',
      header: 'Accept: application/json\nX-Flag\n\n',
      description: { content: 'ignored at request level' },
    });
    expect(req(collection.items[0]).headers.map((h) => [h.key, h.value])).toEqual([
      ['Accept', 'application/json'],
      ['X-Flag', ''],
    ]);
  });

  it('builds a URL from a string path and keeps a query-less param string', () => {
    const { collection } = withRequest({
      url: { host: 'localhost', path: '/v1/items', raw: undefined },
    });
    expect(req(collection.items[0]).url).toBe('localhost/v1/items');
    const { collection: c2 } = withRequest({ url: 'https://x.example.com/?flag&a=b=c' });
    expect(req(c2.items[0]).params.map((q) => [q.key, q.value])).toEqual([
      ['flag', ''],
      ['a', 'b=c'],
    ]);
    const { collection: c3 } = withRequest({ url: 42 });
    expect(req(c3.items[0]).url).toBe('');
  });

  it('maps raw xml / text / json bodies by language', () => {
    const body = (language?: string) =>
      req(
        withRequest({
          url: 'https://x.example.com',
          body: {
            mode: 'raw',
            raw: '<a/>',
            ...(language ? { options: { raw: { language } } } : {}),
          },
        }).collection.items[0]
      ).body;
    expect(body('xml')).toEqual({ type: 'xml', raw: '<a/>' });
    expect(body('json')).toEqual({ type: 'json', raw: '<a/>' });
    expect(body()).toEqual({ type: 'text', raw: '<a/>' });
  });

  it('maps formdata (text, file, multi-file) and urlencoded bodies', () => {
    const formdataBody = {
      mode: 'formdata',
      formdata: [
        { key: 't', value: 'v', description: 'd' },
        { key: 'f', type: 'file', src: '/a.png', disabled: true },
        { key: 'm', type: 'file', src: ['/b.png', '/c.png'] },
      ],
    };
    const fdResult = withRequest({ url: 'https://x.example.com', body: formdataBody });
    // File rows carry base64 bytes in `value` at runtime, so a path never goes
    // there: the row arrives empty (like the `file` body mode), named after the
    // first path, and the full original body is kept + reported.
    expect(
      req(fdResult.collection.items[0]).body.formData?.map((f) => [f.key, f.value, f.fileName])
    ).toEqual([
      ['t', 'v', undefined],
      ['f', '', 'a.png'],
      ['m', '', 'b.png'],
    ]);
    expect(getPostmanSidecar(fdResult.collection.items[0]!)?.body).toEqual(formdataBody);
    expect(fdResult.report.warnings).toEqual([
      expect.objectContaining({ kind: 'unmodelled-construct', construct: 'form-file' }),
    ]);
    const fd = req(
      withRequest({
        url: 'https://x.example.com',
        body: {
          mode: 'formdata',
          formdata: [
            { key: 't', value: 'v', description: 'd' },
            { key: 'f', type: 'file', src: '/a.png', disabled: true },
            { key: 'm', type: 'file', src: ['/b.png', '/c.png'] },
          ],
        },
      }).collection.items[0]
    ).body;
    expect(fd.formData?.map((f) => [f.key, f.value, f.type, f.enabled, f.description])).toEqual([
      ['t', 'v', 'text', true, 'd'],
      ['f', '', 'file', false, undefined],
      ['m', '', 'file', true, undefined],
    ]);
    const ue = req(
      withRequest({
        url: 'https://x.example.com',
        body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: 'b' }] },
      }).collection.items[0]
    ).body;
    expect(ue.type).toBe('x-www-form-urlencoded');
    expect(ue.formData?.map((f) => [f.key, f.value])).toEqual([['a', 'b']]);
  });

  it('collapses graphql bodies, tolerating string and malformed variables', () => {
    const gql = (variables: unknown) =>
      req(
        withRequest({
          url: 'https://x.example.com',
          body: { mode: 'graphql', graphql: { query: '{ a }', variables } },
        }).collection.items[0]
      ).body.raw;
    expect(gql(undefined)).toBe('{ a }');
    expect(JSON.parse(gql('{"x":1}')!)).toEqual({ query: '{ a }', variables: { x: 1 } });
    expect(JSON.parse(gql({ y: 2 })!)).toEqual({ query: '{ a }', variables: { y: 2 } });
    expect(JSON.parse(gql('{not json')!)).toEqual({ query: '{ a }', variables: {} });
  });

  it('unknown body modes become none', () => {
    const { collection } = withRequest({ url: 'https://x.example.com', body: { mode: 'weird' } });
    expect(req(collection.items[0]).body).toEqual({ type: 'none' });
  });
});

describe('parsePostmanV2 — scopes', () => {
  it('folder auth is inherited, request inherit resolves to the parent, folder scripts map', () => {
    const { collection } = importPostmanCollection({
      info: { name: 'C', schema: V21, description: 'desc' },
      variable: [{ id: 'legacyId', value: 3, disabled: true }],
      item: [
        {
          name: 'F',
          auth: { type: 'bearer', bearer: [{ key: 'token', value: 'ft' }] },
          event: [{ listen: 'prerequest', script: 'console.log(1)' }, { listen: 'x' }, 'bad'],
          item: [
            {
              name: 'R',
              request: { url: 'https://x.example.com', auth: { type: 'inherit' } },
            },
          ],
        },
      ],
    });
    expect(collection.description).toBe('desc');
    expect(collection.variables?.map((v) => [v.key, v.value, v.enabled])).toEqual([
      ['legacyId', '3', false],
    ]);
    const folder = collection.items[0]!;
    expect(folder.preRequestScript).toBe('console.log(1)');
    expect(req(folder.items![0]).auth).toEqual({ type: 'bearer', bearer: { token: 'ft' } });
  });

  it('shadowed collection-level events land on the root sidecar', () => {
    const { collection, report } = importPostmanCollection({
      info: { name: 'C', schema: V21 },
      item: [],
      event: [
        { listen: 'test', script: { exec: 'a()' } },
        { listen: 'test', script: { exec: 'b()' } },
      ],
    });
    expect(collection.testScript).toBe('b()');
    expect(getPostmanSidecar(collection)?.event).toEqual([
      { listen: 'test', script: { exec: 'a()' } },
    ]);
    expect(report.warnings).toEqual([
      expect.objectContaining({ kind: 'unmodelled-construct', construct: 'extra-events' }),
    ]);
  });
});
