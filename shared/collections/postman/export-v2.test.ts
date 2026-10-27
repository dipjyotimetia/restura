import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { redactCollectionSecrets } from '../../secrets/collection-redaction';
import type { AuthConfig, Collection, CollectionItem, HttpRequest } from '../../types';
import { exportPostmanV21 } from './export-v2';
import { importPostmanCollection } from './index';

const FIXTURES = resolve(process.cwd(), 'shared/collections/postman/__fixtures__/v21-export');
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v2.1.0/schema.json'), 'utf8')
) as object;
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

function expectValid(doc: unknown) {
  const ok = validate(doc);
  expect(ok ? [] : validate.errors?.slice(0, 5)).toEqual([]);
}

/** Drop generated ids so two imports compare structurally. */
function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k, x]) => k !== 'id' && x !== undefined)
      .map(([k, x]) => [k, normalise(x)])
  );
}

/** export → schema-valid JSON text → import. */
function roundTrip(collection: Collection) {
  const out = exportPostmanV21(collection);
  const json = JSON.parse(JSON.stringify(out.collection)) as unknown;
  expectValid(json);
  return { out, again: importPostmanCollection(json).collection };
}

const kv = (key: string, value: string) => ({ id: key, key, value, enabled: true });

function http(name: string, auth: AuthConfig, extra: Partial<HttpRequest> = {}): CollectionItem {
  return {
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
}

function requestNamed(items: readonly unknown[], name: string): Record<string, unknown> {
  for (const raw of items) {
    const item = raw as { name?: string; item?: unknown[]; request?: unknown };
    if (item.name === name && item.request) return item.request as Record<string, unknown>;
    if (item.item) {
      try {
        return requestNamed(item.item, name);
      } catch {
        /* keep looking */
      }
    }
  }
  throw new Error(`no request ${name}`);
}

describe('Postman v2.1 export — fixtures round-trip (sidecar included)', () => {
  for (const name of ['sidecar.postman_collection.json', 'auth-kinds.postman_collection.json']) {
    it(`${name}: import → export → import is equivalent`, () => {
      const first = importPostmanCollection(fixture(name)).collection;
      const { again } = roundTrip(first);
      expect(normalise(again)).toEqual(normalise(first));
    });
  }

  it('restores saved responses, protocolProfileBehavior, item variables, shadowed events, url variables', () => {
    const first = importPostmanCollection(fixture('sidecar.postman_collection.json')).collection;
    const { out } = roundTrip(first);
    const doc = out.collection as unknown as Record<string, unknown> & { item: unknown[] };
    expect(doc.protocolProfileBehavior).toEqual({ disableBodyPruning: true });
    const orders = doc.item[1] as Record<string, unknown> & { item: Record<string, unknown>[] };
    const get = orders.item[0]!;
    expect(get.protocolProfileBehavior).toEqual({ followRedirects: false, strictSSL: false });
    expect(get.variable).toEqual([{ key: 'itemVar', value: 'i' }]);
    expect((get.response as unknown[]).length).toBe(1);
    expect((get.event as Array<{ listen: string }>).map((e) => e.listen)).toEqual(['test', 'test']);
    const url = (get.request as { url: Record<string, unknown> }).url;
    expect(url.variable).toEqual([
      { key: 'orderId', value: '42', description: 'Order id' },
      { key: 'missing', value: '' },
    ]);
    expect(requestNamed(doc.item, 'Edgegrid').auth).toMatchObject({ type: 'edgegrid' });
    expect(requestNamed(doc.item, 'Explicit none').auth).toEqual({ type: 'noauth' });
    // A child inheriting an unsupported (hawk) folder auth re-exports as inherit.
    expect(requestNamed(doc.item, 'Inherits hawk')).not.toHaveProperty('auth');
    expect((doc.item[0] as { auth?: { type: string } }).auth?.type).toBe('hawk');
    expect(requestNamed(doc.item, 'Upload').body).toMatchObject({
      mode: 'formdata',
      formdata: [
        { key: 'note', value: 'hello', type: 'text' },
        { key: 'file', src: '/tmp/report.pdf', type: 'file' },
      ],
    });
    expect(requestNamed(doc.item, 'Raw file').body).toEqual({
      mode: 'file',
      file: { src: '/tmp/blob.bin' },
    });
  });
});

describe('Postman v2.1 export — auth 1:1', () => {
  const cases: AuthConfig[] = [
    { type: 'basic', basic: { username: 'u', password: 'p' } },
    { type: 'bearer', bearer: { token: 't' } },
    { type: 'api-key', apiKey: { key: 'X-K', value: 'v', in: 'query' } },
    { type: 'digest', digest: { username: 'du', password: 'dp' } },
    { type: 'ntlm', ntlm: { username: 'nu', password: 'np', domain: 'D', workstation: 'W' } },
    {
      type: 'oauth1',
      oauth1: {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        accessToken: 'at',
        accessTokenSecret: 'ats',
        signatureMethod: 'HMAC-SHA1',
        realm: 'r',
      },
    },
    {
      type: 'oauth2',
      oauth2: {
        accessToken: 'tok',
        grantType: 'client_credentials',
        clientId: 'cid',
        clientSecret: 'cs',
        tokenUrl: 'https://a/token',
        scope: 'read',
      },
    },
    {
      type: 'aws-signature',
      awsSignature: {
        accessKey: 'AK',
        secretKey: 'SK',
        region: 'us-east-1',
        service: 'execute-api',
      },
    },
  ];
  for (const auth of cases) {
    it(`${auth.type} exports and re-imports unchanged`, () => {
      const c: Collection = { id: 'c', name: 'C', items: [http('R', auth)] };
      const { out, again } = roundTrip(c);
      expect(out.report.entries).toEqual([]);
      const request = (again.items[0]?.request ?? {}) as HttpRequest;
      expect(request.auth).toEqual(auth);
    });
  }

  it('digest / oauth1 / ntlm are no longer dropped', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [
        http('D', { type: 'digest', digest: { username: 'a', password: 'b' } }),
        http('O', { type: 'oauth1', oauth1: { consumerKey: 'k', consumerSecret: 's' } }),
        http('N', { type: 'ntlm', ntlm: { username: 'a', password: 'b' } }),
      ],
    };
    const doc = exportPostmanV21(c).collection;
    expect(
      doc.item.map((i) =>
        'request' in i ? (i.request as { auth?: { type: string } }).auth?.type : ''
      )
    ).toEqual(['digest', 'oauth1', 'ntlm']);
  });

  it('inherit = no auth block; none under a configured parent = explicit noauth', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      auth: { type: 'bearer', bearer: { token: 'col' } },
      items: [
        http('Inherits', { type: 'bearer', bearer: { token: 'col' } }),
        http('Open', { type: 'none' }),
      ],
    };
    const doc = exportPostmanV21(c).collection;
    expect(requestNamed(doc.item, 'Inherits')).not.toHaveProperty('auth');
    expect(requestNamed(doc.item, 'Open').auth).toEqual({ type: 'noauth' });
  });

  it('WSSE is reported and exported as noauth', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [http('W', { type: 'wsse', wsse: { username: 'u', password: 'p' } } as AuthConfig)],
    };
    const out = exportPostmanV21(c);
    expect(requestNamed(out.collection.item, 'W').auth).toEqual({ type: 'noauth' });
    expect(out.report.entries.map((e) => e.construct)).toContain('wsse-auth');
  });

  it('jwt / asap sidecar auth (no v2.1 type) is reported; children of such a folder get explicit noauth', () => {
    const folder: CollectionItem = {
      id: 'f',
      name: 'JWT folder',
      type: 'folder',
      items: [http('Child', { type: 'none' })],
    };
    Object.assign(folder, {
      _postman: { auth: { type: 'jwt', jwt: [{ key: 'algorithm', value: 'HS256' }] } },
    });
    const c: Collection = {
      id: 'c',
      name: 'C',
      auth: { type: 'bearer', bearer: { token: 'col' } },
      items: [folder],
    };
    const out = exportPostmanV21(c);
    expectValid(JSON.parse(JSON.stringify(out.collection)));
    expect(requestNamed(out.collection.item, 'Child').auth).toEqual({ type: 'noauth' });
    expect(out.report.entries).toContainEqual(
      expect.objectContaining({ construct: 'auth-unsupported-for-kind', itemName: 'JWT folder' })
    );
  });
});

describe('Postman v2.1 export — secrets', () => {
  it('keychain handles and external refs are written EMPTY and reported', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [
        http('H', {
          type: 'bearer',
          bearer: { token: { kind: 'handle', id: 'h1', label: 'tok' } },
        }),
      ],
    };
    const out = exportPostmanV21(c);
    const text = JSON.stringify(out.collection);
    expect(text).not.toContain('h1');
    expect(text).not.toContain('{{handle');
    expect(out.report.entries.map((e) => e.construct)).toEqual(['secret-handle']);
  });

  it('secret variables are emptied even when secrets are included; private ones are left out', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      variables: [
        { ...kv('s', 'plain-secret'), secret: true },
        { ...kv('p', 'local-only'), private: true },
        kv('host', 'api.example.com'),
      ],
      items: [],
    };
    const out = exportPostmanV21(c);
    const text = JSON.stringify(out.collection);
    expect(text).not.toContain('plain-secret');
    expect(text).not.toContain('local-only');
    expect(out.collection.variable).toEqual([
      { key: 's', value: '' },
      { key: 'host', value: 'api.example.com' },
    ]);
    expect(out.report.entries).toContainEqual(
      expect.objectContaining({ construct: 'secret-variable', kind: 'emptied' })
    );
  });

  it('secret-typed item variables kept in the sidecar are emptied too', () => {
    const item = http('R', { type: 'none' });
    Object.assign(item, {
      _postman: { variable: [{ key: 'k', value: 'sidecar-secret', type: 'secret' }] },
    });
    const out = exportPostmanV21({ id: 'c', name: 'C', items: [item] });
    expect(JSON.stringify(out.collection)).not.toContain('sidecar-secret');
    expect(out.report.entries).toContainEqual(
      expect.objectContaining({ construct: 'secret-variable', itemName: 'R' })
    );
  });

  it('without "include secrets" no sidecar credential reaches the file', () => {
    const first = importPostmanCollection(fixture('sidecar.postman_collection.json')).collection;
    const out = exportPostmanV21(redactCollectionSecrets(first));
    const text = JSON.stringify(out.collection);
    expect(text).not.toContain('col-token');
    expect(text).not.toContain('hawk-id');
  });
});

describe('Postman v2.1 export — report and kinds', () => {
  it('non-HTTP items are skipped and reported; v2.1 target version', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [
        http('Keep', { type: 'none' }),
        {
          id: 'g',
          name: 'Greeter',
          type: 'request',
          request: {
            id: 'g',
            name: 'Greeter',
            type: 'grpc',
            url: 'grpc://x',
            service: 'S',
            method: 'M',
            message: '{}',
            metadata: [],
            auth: { type: 'none' },
          } as never,
        },
        {
          id: 's',
          name: 'Stream',
          type: 'request',
          request: {
            id: 's',
            name: 'Stream',
            type: 'sse',
            url: 'https://x',
            headers: [],
            params: [],
            auth: { type: 'none' },
          } as never,
        },
      ],
    };
    const out = exportPostmanV21(c);
    expect(out.report.targetVersion).toBe('2.1');
    expect(out.collection.item.map((i) => i.name)).toEqual(['Keep']);
    expect(out.report.entries.filter((e) => e.construct === 'non-http-request')).toEqual([
      expect.objectContaining({ kind: 'dropped', itemName: 'Greeter' }),
      expect.objectContaining({ kind: 'dropped', itemName: 'Stream' }),
    ]);
  });

  it('GraphQL maps to a v2.1 graphql body and round-trips', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [
        http(
          'Q',
          { type: 'none' },
          {
            method: 'POST',
            body: { type: 'graphql', raw: 'query { me { id } }', graphqlVariables: '{"a":1}' },
          }
        ),
      ],
    };
    const { out, again } = roundTrip(c);
    expect(requestNamed(out.collection.item, 'Q').body).toEqual({
      mode: 'graphql',
      graphql: { query: 'query { me { id } }', variables: '{"a":1}' },
    });
    const body = (again.items[0]?.request as HttpRequest).body;
    expect(body.type).toBe('graphql');
    expect(JSON.parse(body.raw ?? '')).toEqual({
      query: 'query { me { id } }',
      variables: { a: 1 },
    });
    // …and the imported shape exports the same graphql body again.
    expect(requestNamed(exportPostmanV21(again).collection.item, 'Q').body).toEqual({
      mode: 'graphql',
      graphql: { query: 'query { me { id } }', variables: '{"a":1}' },
    });
  });

  it('disabled query params survive (object URL with query rows)', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [
        http(
          'P',
          { type: 'none' },
          {
            url: '{{baseUrl}}/items',
            params: [kv('page', '1'), { ...kv('debug', 'true'), enabled: false }],
          }
        ),
      ],
    };
    const { again } = roundTrip(c);
    const req = again.items[0]?.request as HttpRequest;
    expect(req.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['page', '1', true],
      ['debug', 'true', false],
    ]);
    expect(req.url).toBe('{{baseUrl}}/items');
  });

  it('Restura-only settings and contract specs are reported', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      contractSpec: { kind: 'openapi' } as never,
      items: [http('S', { type: 'none' }, { settings: { timeout: 5000, followRedirects: false } })],
    };
    const out = exportPostmanV21(c);
    expect(out.report.entries.map((e) => e.construct)).toEqual(
      expect.arrayContaining(['restura-settings', 'contract-spec'])
    );
    const item = out.collection.item[0] as { protocolProfileBehavior?: unknown };
    expect(item.protocolProfileBehavior).toEqual({ followRedirects: false });
  });
});
