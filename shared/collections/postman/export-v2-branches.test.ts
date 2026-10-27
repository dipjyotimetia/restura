import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import type { AuthConfig, Collection, CollectionItem, HttpRequest } from '../../types';
import { PostmanExportReportBuilder } from './export-report';
import { exportPostmanV21 } from './export-v2';
import { restoreBagOnlyAuth } from './export-v3-shared';
import { importPostmanCollection } from './index';

/** Edge / branch coverage for the v2.1 exporter (#1229 review). */

const FIXTURES = resolve(process.cwd(), 'shared/collections/postman/__fixtures__/v21-export');
const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v2.1.0/schema.json'), 'utf8')
) as object;
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
const expectValid = (doc: unknown) => {
  const ok = validate(JSON.parse(JSON.stringify(doc)));
  expect(ok ? [] : validate.errors?.slice(0, 5)).toEqual([]);
};

const kv = (key: string, value: string, extra: Record<string, unknown> = {}) => ({
  id: key,
  key,
  value,
  enabled: true,
  ...extra,
});

function http(
  name: string,
  extra: Partial<HttpRequest> = {},
  sidecar?: Record<string, unknown>,
  auth: AuthConfig = { type: 'none' }
): CollectionItem {
  const item: CollectionItem = {
    id: name,
    name,
    type: 'request',
    request: {
      id: name,
      name,
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/x',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth,
      ...extra,
    },
  };
  if (sidecar) Object.assign(item, { _postman: sidecar });
  return item;
}

const one = (item: CollectionItem, extra: Partial<Collection> = {}) => {
  const out = exportPostmanV21({ id: 'c', name: 'C', items: [item], ...extra });
  expectValid(out.collection);
  const first = out.collection.item[0] as Record<string, unknown> & {
    request: Record<string, unknown>;
  };
  return { out, item: first, request: first.request };
};

const constructs = (out: ReturnType<typeof exportPostmanV21>) =>
  out.report.entries.map((e) => e.construct);

describe('v2.1 export — sidecar variables (#1228 secret rows)', () => {
  it('value-less type:"secret" rows are written as plain empty variables and reported', () => {
    const c = JSON.parse(
      readFileSync(join(FIXTURES, 'secret-vars.restura.json'), 'utf8')
    ) as Collection;
    const out = exportPostmanV21(c);
    expectValid(out.collection);
    const text = JSON.stringify(out.collection);
    expect(text).not.toContain('"secret"');
    const folder = out.collection.item[0] as { variable?: unknown[]; item: unknown[] };
    expect(folder.variable).toEqual([{ key: 'folderSecret', value: '' }]);
    expect((folder.item[0] as { variable?: unknown[] }).variable).toEqual([
      { key: 'reqSecret', value: '' },
      { key: 'plain', value: 'p', type: 'string' },
    ]);
    expect(
      out.report.entries
        .filter((e) => e.construct === 'secret-variable')
        .map((e) => [e.itemName, e.kind])
    ).toEqual([
      ['Req', 'emptied'],
      ['Folder', 'emptied'],
    ]);
  });

  it('kept rows are narrowed to schema fields and cloned, never aliased', () => {
    const sidecarVar = {
      id: 'v1',
      name: 'n',
      description: { content: 'd' },
      system: false,
      disabled: true,
      value: { nested: 1 },
      type: 'object-ish',
      extra: 'dropped',
    };
    const ppb = { tlsDisabledProtocols: ['TLSv1'] };
    const { item } = one(http('R', {}, { variable: [sidecarVar], protocolProfileBehavior: ppb }));
    expect(item.variable).toEqual([
      {
        id: 'v1',
        value: { nested: 1 },
        name: 'n',
        description: { content: 'd' },
        system: false,
        disabled: true,
      },
    ]);
    (item.protocolProfileBehavior as typeof ppb).tlsDisabledProtocols.push('mutated');
    expect(ppb.tlsDisabledProtocols).toEqual(['TLSv1']);
  });

  it('folder variables export (private skipped, Restura key wins over the sidecar one)', () => {
    const folder: CollectionItem = {
      id: 'f',
      name: '',
      type: 'folder',
      items: [],
      variables: [
        kv('a', '1', { description: 'first', enabled: false }),
        kv('p', 'x', { private: true }),
        kv('h', 'handle', { secretRef: { kind: 'handle', id: 'h1' } }),
      ],
      contractSpec: { kind: 'openapi' } as never,
    };
    Object.assign(folder, {
      _postman: {
        variable: [{ key: 'a', value: 'old' }, { id: 'b', value: '2' }, 'junk'],
        description: 'Folder description',
        protocolProfileBehavior: { strictSSL: false },
      },
    });
    const out = exportPostmanV21({ id: 'c', name: '', items: [folder] });
    expectValid(out.collection);
    expect(out.collection.info.name).toBe('Untitled Collection');
    const f = out.collection.item[0] as unknown as Record<string, unknown>;
    expect(f.name).toBe('Untitled');
    expect(f.description).toBe('Folder description');
    expect(f.protocolProfileBehavior).toEqual({ strictSSL: false });
    expect(f.variable).toEqual([
      { key: 'a', value: '1', disabled: true, description: 'first' },
      { key: 'h', value: '' },
      { id: 'b', value: '2' },
    ]);
    expect(constructs(out)).toEqual(expect.arrayContaining(['contract-spec', 'secret-variable']));
  });
});

describe('v2.1 export — events', () => {
  it('restores raw v2 and v3-shaped shadowed scripts, other listens last, and reports them', () => {
    const { item, out } = one(
      http(
        'E',
        { preRequestScript: 'rs.variables.set("a", 1);', testScript: 'rs.test("t", () => {});' },
        {
          event: [
            {
              id: 'e1',
              listen: 'test',
              disabled: true,
              script: { id: 's', type: 'text/javascript', exec: 'one line', name: 'n' },
            },
            { listen: 'custom', script: { exec: ['x'] } },
            { listen: 'test', script: { exec: 42 } },
            { listen: 'test' },
            { type: 'http:beforeRequest', code: 'a\nb' },
            { type: 'afterResponse', code: 'c' },
            { type: 'unknownPhase', code: 'd' },
            { type: 'beforeRequest' },
            'junk',
          ],
        }
      )
    );
    const events = item.event as Array<{ listen: string; script: { exec: unknown } }>;
    expect(events.map((e) => e.listen)).toEqual([
      'prerequest',
      'prerequest',
      'test',
      'test',
      'test',
      'custom',
    ]);
    expect(events[0]?.script.exec).toEqual(['a', 'b']);
    expect(events[2]).toMatchObject({
      id: 'e1',
      disabled: true,
      script: { exec: 'one line', name: 'n', id: 's' },
    });
    expect(out.report.entries).toContainEqual(
      expect.objectContaining({ construct: 'restored-events', kind: 'approximated', itemName: 'E' })
    );
  });
});

describe('v2.1 export — URLs', () => {
  it('object form carries protocol, port, host parts, inline query, hash and descriptions', () => {
    const { request } = one(
      http('U', {
        url: 'http://api.example.com:8080/v1/items?fixed=1#frag',
        params: [kv('q', 'v', { description: 'a query' }), kv('', 'skip')],
      })
    );
    expect(request.url).toEqual({
      raw: 'http://api.example.com:8080/v1/items?fixed=1&q=v#frag',
      protocol: 'http',
      host: ['api', 'example', 'com'],
      port: '8080',
      path: ['v1', 'items'],
      query: [
        { key: 'fixed', value: '1' },
        { key: 'q', value: 'v', description: 'a query' },
        { key: '', value: 'skip' },
      ],
      hash: 'frag',
    });
  });

  it('templated hosts stay one segment; bare hosts have no path; plain URLs stay strings', () => {
    const templated = one(
      http('T', { url: '{{host}}:{{port}}', params: [kv('a', '1', { enabled: false })] })
    ).request.url as Record<string, unknown>;
    expect(templated.host).toEqual(['{{host}}:{{port}}']);
    expect(templated).not.toHaveProperty('path');
    expect(templated).not.toHaveProperty('port');
    const empty = one(http('E', { url: '', params: [kv('a', '1', { enabled: false })] })).request
      .url as Record<string, unknown>;
    expect(empty).not.toHaveProperty('host');
    expect(
      one(http('S', { url: 'https://x.example.com/a?b=1', params: [kv('c', '2')] })).request.url
    ).toBe('https://x.example.com/a?b=1&c=2');
  });
});

describe('v2.1 export — bodies', () => {
  it('raw languages, urlencoded rows, unsupported bodies', () => {
    expect(one(http('X', { body: { type: 'xml', raw: '<a/>' } })).request.body).toEqual({
      mode: 'raw',
      raw: '<a/>',
      options: { raw: { language: 'xml' } },
    });
    expect(one(http('T', { body: { type: 'text' } })).request.body).toMatchObject({ raw: '' });
    const form = [
      { id: '1', key: 'a', value: '1', enabled: false, type: 'text' as const, description: 'd' },
    ];
    expect(
      one(http('U', { body: { type: 'x-www-form-urlencoded', formData: form } })).request.body
    ).toEqual({
      mode: 'urlencoded',
      urlencoded: [{ key: 'a', value: '1', disabled: true, description: 'd' }],
    });
    const { request, out } = one(http('P', { body: { type: 'protobuf', raw: 'x' } }));
    expect(request).not.toHaveProperty('body');
    expect(constructs(out)).toEqual(['body-unsupported']);
  });

  it('binary: v2 / v3 kept paths restored (reported), otherwise emptied', () => {
    const v2 = one(
      http('B', { body: { type: 'binary' } }, { body: { mode: 'file', file: { src: '/tmp/a' } } })
    );
    expect(v2.request.body).toEqual({ mode: 'file', file: { src: '/tmp/a' } });
    expect(constructs(v2.out)).toEqual(['restored-file-path']);
    const v3 = one(
      http('B', { body: { type: 'binary' } }, { body: { type: 'file', content: { src: null } } })
    );
    expect(v3.request.body).toEqual({ mode: 'file', file: { src: null } });
    expect(constructs(v3.out)).toEqual([]);
    const none = one(http('B', { body: { type: 'binary' } }, { body: { mode: 'raw' } }));
    expect(none.request.body).toEqual({ mode: 'file', file: {} });
    expect(constructs(none.out)).toEqual(['binary-body']);
  });

  it('form-data: kept v3 rows in sync are restored; out-of-sync rows rebuild with kept src', () => {
    const live = [
      {
        id: '1',
        key: 'note',
        value: 'hi',
        enabled: true,
        type: 'text' as const,
        contentType: 'text/plain',
      },
      { id: '2', key: 'f', value: '', enabled: false, type: 'file' as const, fileName: 'a.png' },
    ];
    const keptV3 = {
      type: 'formdata',
      content: [
        { type: 'text', key: 'note', value: '', contentType: 'text/plain', description: 'n' },
        { type: 'file', key: 'f', src: ['/tmp/a.png'], disabled: true },
        'junk',
      ],
    };
    const inSync = one(
      http('F', { body: { type: 'form-data', formData: live } }, { body: keptV3 })
    );
    expect((inSync.request.body as { formdata: unknown[] }).formdata).toEqual([
      { key: 'note', value: '', type: 'text', contentType: 'text/plain', description: 'n' },
      { key: 'f', src: ['/tmp/a.png'], type: 'file', disabled: true },
    ]);
    expect(constructs(inSync.out)).toEqual(['restored-file-path']);

    const edited = [
      ...live,
      { id: '3', key: 'g', value: '', enabled: true, type: 'file' as const },
    ];
    const rebuilt = one(
      http('F', { body: { type: 'form-data', formData: edited } }, { body: keptV3 })
    );
    expect((rebuilt.request.body as { formdata: unknown[] }).formdata).toEqual([
      { key: 'note', value: 'hi', type: 'text', contentType: 'text/plain' },
      { key: 'f', src: ['/tmp/a.png'], type: 'file', disabled: true },
      { key: 'g', src: '', type: 'file' },
    ]);
    expect(constructs(rebuilt.out)).toEqual(['form-file', 'restored-file-path']);

    const mismatch = (rows: unknown[]) =>
      one(
        http(
          'M',
          { body: { type: 'form-data', formData: live } },
          { body: { mode: 'formdata', formdata: rows } }
        )
      );
    // key, kind, disabled and value mismatches all rebuild from the live rows.
    for (const rows of [
      [
        { key: 'other', value: 'hi' },
        { key: 'f', type: 'file', disabled: true },
      ],
      [
        { key: 'note', type: 'file' },
        { key: 'f', type: 'file', disabled: true },
      ],
      [
        { key: 'note', value: 'hi', disabled: true },
        { key: 'f', type: 'file', disabled: true },
      ],
      [
        { key: 'note', value: 'changed' },
        { key: 'f', type: 'file', disabled: true, src: null },
      ],
    ]) {
      const body = mismatch(rows).request.body as { formdata: Array<{ key: string }> };
      expect(body.formdata.map((r) => r.key)).toEqual(['note', 'f']);
    }
    expect(one(http('N', { body: { type: 'form-data' } })).request.body).toEqual({
      mode: 'formdata',
      formdata: [],
    });
  });

  it('graphql: plain query, raw JSON with null variables, operationName and extras reported', () => {
    const plain = one(http('G', { method: 'POST', body: { type: 'graphql', raw: '{ me }' } }));
    expect(plain.request.body).toEqual({ mode: 'graphql', graphql: { query: '{ me }' } });
    const json = one(
      http('G', {
        body: {
          type: 'graphql',
          raw: '{"query":"{ a }","variables":null}',
          graphqlOperationName: 'Op',
        },
        graphqlSchema: { sdl: 'type Q', source: 'sdl', importedAt: 0 },
      })
    );
    expect(json.request.body).toEqual({ mode: 'graphql', graphql: { query: '{ a }' } });
    expect(constructs(json.out)).toEqual(['graphql-extras', 'graphql-extras']);
    const nonQuery = one(http('G', { body: { type: 'graphql', raw: '{"x":1}' } }));
    expect(nonQuery.request.body).toEqual({ mode: 'graphql', graphql: { query: '{"x":1}' } });
    expect(one(http('G', { body: { type: 'graphql' } })).request.body).toEqual({
      mode: 'graphql',
      graphql: { query: '' },
    });
  });
});

describe('v2.1 export — settings, methods, responses, items', () => {
  it('maps every Postman-equivalent setting and reports the Restura-only ones', () => {
    const base = {
      verifySsl: false,
      maxRedirects: 3,
      followOriginalMethod: true,
      followAuthHeader: true,
      stripReferer: true,
      encodeUrlAutomatically: false,
      disableCookieJar: true,
      serverCipherOrder: true,
      cipherSuites: 'A:B:',
    };
    const http1 = one(http('S', { settings: { ...base, httpVersion: 'http1.1' } }));
    expect(http1.item.protocolProfileBehavior).toEqual({
      protocolVersion: 'http1',
      strictSSL: false,
      maxRedirects: 3,
      followOriginalHttpMethod: true,
      followAuthorizationHeader: true,
      removeRefererHeaderOnRedirect: true,
      disableUrlEncoding: true,
      disableCookies: true,
      tlsPreferServerCiphers: true,
      tlsCipherSelection: ['A', 'B'],
    });
    expect(constructs(http1.out)).toEqual([]);
    for (const [httpVersion, protocolVersion] of [
      ['http2', 'http2'],
      ['auto', 'auto'],
    ] as const) {
      expect(one(http('S', { settings: { httpVersion } })).item.protocolProfileBehavior).toEqual({
        protocolVersion,
      });
    }
    const h2c = one(
      http('S', { settings: { httpVersion: 'h2c-prior-knowledge', proxy: {} as never } })
    );
    expect(h2c.item).not.toHaveProperty('protocolProfileBehavior');
    expect(h2c.out.report.entries[0]?.detail).toContain('proxy, httpVersion h2c-prior-knowledge');
  });

  it('restores an unsendable method, picks saved-response fields, keeps request descriptions', () => {
    const { request, item } = one(
      http(
        'M',
        { description: 'About', headers: [kv('X', '1', { enabled: false, description: 'h' })] },
        {
          method: 'get me',
          response: [{ name: 'OK', code: 200, unknownKey: 'dropped' }, 'junk'],
        }
      )
    );
    expect(request.method).toBe('get me');
    expect(request.description).toBe('About');
    expect(request.header).toEqual([{ key: 'X', value: '1', disabled: true, description: 'h' }]);
    expect(item.response).toEqual([{ name: 'OK', code: 200 }]);
    // A kept method only applies while the live method is still the GET it was imported as.
    expect(one(http('M', { method: 'POST' }, { method: 'get me' })).request.method).toBe('POST');
  });

  it('skips v3 placeholder folders and empty request items; names fall back', () => {
    const placeholder: CollectionItem = { id: 'p', name: 'WS', type: 'folder', items: [] };
    Object.assign(placeholder, { _postman: { item: { $kind: 'websocket-request' } } });
    const notPlaceholder: CollectionItem = { id: 'q', name: 'Q', type: 'folder' };
    Object.assign(notPlaceholder, { _postman: { item: { $kind: 'collection' } } });
    const empty: CollectionItem = { id: 'e', name: 'E', type: 'request' };
    const unnamed = http('');
    const out = exportPostmanV21({
      id: 'c',
      name: 'C',
      description: 'Collection description',
      items: [placeholder, notPlaceholder, empty, unnamed],
    });
    expectValid(out.collection);
    expect(out.collection.info.description).toBe('Collection description');
    expect(out.collection.item.map((i) => i.name)).toEqual(['Q', 'Untitled']);
    expect(out.report.entries).toEqual([
      expect.objectContaining({ construct: 'placeholder-item', itemName: 'WS' }),
    ]);
  });

  it('a v2.0 map-shaped sidecar auth and a bag-only auth are handled', () => {
    const mapAuth = one(
      http('H', {}, { auth: { type: 'hawk', hawk: { authId: 'id', algorithm: 'sha256' } } })
    );
    expect(mapAuth.request.auth).toEqual({
      type: 'hawk',
      hawk: [
        { key: 'authId', value: 'id' },
        { key: 'algorithm', value: 'sha256' },
      ],
    });
    const bagOnly = one(http('B', {}, { auth: { type: 'hawk', hawk: [] }, authBagOnly: true }));
    expect(bagOnly.request).not.toHaveProperty('auth');
    const noBlock = one(http('N', {}, { auth: { type: 'hawk' } }));
    expect(noBlock.request.auth).toEqual({ type: 'hawk', hawk: [] });
  });

  it('OAuth2 PKCE grant is restored only while the typed grant is unchanged', () => {
    const pkce = importPostmanCollection({
      info: {
        name: 'P',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'R',
          request: {
            url: 'https://x.example.com',
            auth: {
              type: 'oauth2',
              oauth2: [
                { key: 'grant_type', value: 'authorization_code_with_pkce', type: 'string' },
              ],
            },
          },
        },
      ],
    }).collection;
    const grant = (c: Collection) => {
      const auth = (
        exportPostmanV21(c).collection.item[0] as {
          request: { auth: { oauth2: Array<{ key: string; value: unknown }> } };
        }
      ).request.auth;
      return auth.oauth2.find((a) => a.key === 'grant_type')?.value;
    };
    expect(grant(pkce)).toBe('authorization_code_with_pkce');
    const req = pkce.items[0]?.request as HttpRequest;
    req.auth = {
      type: 'oauth2',
      oauth2: { ...req.auth.oauth2, grantType: 'client_credentials' },
    } as AuthConfig;
    expect(grant(pkce)).toBe('client_credentials');
  });

  it('a jwt collection root cuts inheritance for every child', () => {
    const c: Collection = { id: 'c', name: 'C', items: [http('R')] };
    Object.assign(c, { _postman: { auth: { type: 'jwt', jwt: [] } } });
    const out = exportPostmanV21(c);
    expectValid(out.collection);
    expect(out.collection.auth).toEqual({ type: 'noauth' });
    expect((out.collection.item[0] as { request: { auth?: unknown } }).request.auth).toEqual({
      type: 'noauth',
    });
    const configured: Collection = {
      id: 'c',
      name: 'C',
      items: [http('R', {}, undefined, { type: 'bearer', bearer: { token: 't' } })],
    };
    Object.assign(configured, { _postman: { auth: { type: 'asap', asap: [] } } });
    const r = exportPostmanV21(configured).collection.item[0] as {
      request: { auth?: { type: string } };
    };
    expect(r.request.auth?.type).toBe('bearer');
  });
});

describe('v2.1 export — remaining edges', () => {
  it('variables: id-only secret rows, value-less plain rows; path variables without params', () => {
    const { item, request, out } = one(
      http(
        'V',
        { url: '{{h}}:8080/a' },
        {
          variable: [{ id: 'sid', type: 'secret', secret: true }, { key: 'k' }],
          urlVariable: [{ key: 'id' }, 'junk'],
        }
      )
    );
    expect(item.variable).toEqual([{ id: 'sid', value: '' }, { key: 'k' }]);
    expect(request.url).toEqual({
      raw: '{{h}}:8080/a',
      host: ['{{h}}'],
      port: '8080',
      path: ['a'],
      variable: [{ key: 'id' }],
    });
    expect(out.report.entries.map((e) => e.itemName)).toEqual(['V']);
  });

  it('bodies: non-form kept body, in-sync rows without a path, binary without a sidecar, plain urlencoded rows', () => {
    const live = [{ id: '1', key: 'f', value: '', enabled: true, type: 'file' as const }];
    const raw = one(
      http('F', { body: { type: 'form-data', formData: live } }, { body: { mode: 'raw' } })
    );
    expect(constructs(raw.out)).toEqual(['form-file']);
    const notArray = one(
      http(
        'F',
        { body: { type: 'form-data', formData: live } },
        { body: { mode: 'formdata', formdata: 'x' } }
      )
    );
    expect(constructs(notArray.out)).toEqual(['form-file']);
    const noPath = one(
      http(
        'F',
        { body: { type: 'form-data', formData: live } },
        { body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: null }] } }
      )
    );
    expect(constructs(noPath.out)).toEqual([]);
    expect(constructs(one(http('B', { body: { type: 'binary' } })).out)).toEqual(['binary-body']);
    const rows = [{ id: '1', key: 'a', value: '1', enabled: true, type: 'text' as const }];
    expect(
      one(http('U', { body: { type: 'x-www-form-urlencoded', formData: rows } })).request.body
    ).toEqual({
      mode: 'urlencoded',
      urlencoded: [{ key: 'a', value: '1' }],
    });
  });

  it('auth: bag-only sidecars and non-param entries are ignored; implicit grants are not rewritten', () => {
    const bagOnly = one(
      http(
        'A',
        {},
        {
          auth: {
            type: 'oauth2',
            oauth2: [{ key: 'grant_type', value: 'authorization_code_with_pkce' }],
          },
          authBagOnly: true,
        },
        {
          type: 'oauth2',
          oauth2: { accessToken: 't', grantType: 'authorization_code' },
        }
      )
    );
    expect(JSON.stringify(bagOnly.request.auth)).not.toContain('pkce');
    const odd = one(
      http(
        'O',
        {},
        {
          auth: {
            type: 'oauth2',
            oauth2: [
              'junk',
              { key: 'grant_type', value: 'implicit' },
              { key: 'x', value: 1, type: 'number' },
            ],
          },
        },
        {
          type: 'oauth2',
          oauth2: { accessToken: 't' },
        }
      )
    );
    expect(odd.request.auth).toEqual({
      type: 'oauth2',
      oauth2: [
        { key: 'accessToken', value: 't', type: 'string' },
        { key: 'grant_type', value: 'implicit' },
        { key: 'x', value: 1, type: 'number' },
      ],
    });
    const noGrant = one(
      http(
        'N',
        {},
        { auth: { type: 'oauth2', oauth2: ['junk'] } },
        { type: 'oauth2', oauth2: { accessToken: 't' } }
      )
    );
    expect(noGrant.request.auth).toMatchObject({ type: 'oauth2' });
  });

  it('a child with its own kept auth under a jwt folder keeps that auth', () => {
    const child = http(
      'Hawk child',
      {},
      { auth: { type: 'hawk', hawk: [{ key: 'authId', value: 'i' }] } }
    );
    const folder: CollectionItem = { id: 'f', name: 'JWT', type: 'folder', items: [child] };
    Object.assign(folder, { _postman: { auth: { type: 'jwt', jwt: [] } } });
    const out = exportPostmanV21({ id: 'c', name: 'C', items: [folder] });
    const req = (
      out.collection.item[0] as { item: Array<{ request: { auth?: { type: string } } }> }
    ).item[0];
    expect(req?.request.auth?.type).toBe('hawk');
  });

  it('bag-only restores (no report context) never write a handle', () => {
    const restored = restoreBagOnlyAuth(
      {
        authBagOnly: true,
        auth: {
          type: 'basic',
          basic: [
            { key: 'username', value: { kind: 'inline', value: 'u' } },
            { key: 'password', value: { kind: 'handle', id: 'h', label: 'L' } },
          ],
        },
      },
      new Set(['basic'])
    );
    expect(restored).toEqual({
      type: 'basic',
      credentials: [
        { key: 'username', value: 'u' },
        { key: 'password', value: '' },
      ],
    });
    expect(new PostmanExportReportBuilder().build().targetVersion).toBe('3.0');
    expect(
      restoreBagOnlyAuth({ authBagOnly: true, auth: { type: '' } }, new Set())
    ).toBeUndefined();
    expect(restoreBagOnlyAuth({ authBagOnly: true, auth: 'raw' }, new Set())).toBeUndefined();
  });
});
