import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../../secrets/collection-redaction';
import type { AuthConfig, Collection, CollectionItem, CollectionRequest } from '../../types';
import { exportPostmanV3 } from './export-v3';
import { safeFileName } from './export-v3-files';
import { importPostmanCollection, importPostmanV3Files } from './index';
import { readPostmanV3Container } from './v3-container';

const FIXTURES = resolve(process.cwd(), 'shared/collections/postman/__fixtures__/v3');

function loadFileMap(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v3.0.0/schema.json'), 'utf8')
) as object;
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

function expectValid(tree: unknown) {
  const ok = validate(tree);
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

function roundTrip(collection: Collection) {
  const out = exportPostmanV3(collection);
  expectValid(out.tree);
  // The file map reads back to a schema-valid logical tree…
  expectValid(readPostmanV3Container(out.files).tree);
  // …and imports (as a zip / picked folder would, under a wrapper directory).
  const wrapped = Object.fromEntries(
    Object.entries(out.files).map(([p, text]) => [`${safeFileName(collection.name)}/${p}`, text])
  );
  const again = importPostmanV3Files(wrapped).collection;
  return { out, again };
}

describe('Postman v3 export — golden fixtures round-trip', () => {
  for (const fixture of ['kitchen-sink', 'nested', 'all-kinds.json', 'folder-unsupported-auth']) {
    it(`${fixture}: import → export → import is equivalent (sidecar included)`, () => {
      const input = fixture.endsWith('.json')
        ? (JSON.parse(readFileSync(join(FIXTURES, fixture), 'utf8')) as unknown)
        : loadFileMap(join(FIXTURES, fixture));
      const first = fixture.endsWith('.json')
        ? importPostmanCollection(input).collection
        : importPostmanV3Files(input as Record<string, string>).collection;
      const { again } = roundTrip(first);
      expect(normalise(again)).toEqual(normalise(first));
    });
  }

  it('children inheriting an unsupported folder auth (hawk) export WITHOUT an auth key', () => {
    const first = importPostmanV3Files(
      loadFileMap(join(FIXTURES, 'folder-unsupported-auth'))
    ).collection;
    const { files } = exportPostmanV3(first);
    expect(files['Signed/.resources/definition.yaml']).toMatch(/type: hawk/);
    expect(files['Signed/Inherits.request.yaml']).not.toMatch(/^auth:/m);
    expect(files['Signed/Own basic.request.yaml']).toMatch(/type: basic/);
    expect(files['Top.request.yaml']).not.toMatch(/^auth:/m);
    expect(files['.resources/definition.yaml']).toMatch(/type: bearer/);
  });

  it('collection-level unsupported auth: inheriting requests export without auth', () => {
    const c = {
      id: 'c',
      name: 'C',
      auth: { type: 'none' },
      items: [httpReq('R', { type: 'none' })],
      _postman: { auth: { type: 'jwt', jwt: [{ key: 'algorithm', value: 'HS256' }] } },
    } as Collection;
    const { files } = exportPostmanV3(c);
    expect(files['.resources/definition.yaml']).toMatch(/type: jwt/);
    expect(files['R.request.yaml']).not.toMatch(/^auth:/m);
  });

  it('writes the migrate layout: root + folder definitions, request files, order, examples', () => {
    const first = importPostmanV3Files(loadFileMap(join(FIXTURES, 'kitchen-sink'))).collection;
    const { files } = exportPostmanV3(first);
    const paths = Object.keys(files).sort();
    expect(paths).toContain('.resources/definition.yaml');
    expect(paths).toContain('Users/.resources/definition.yaml');
    expect(paths).toContain('Users/List users.request.yaml');
    expect(paths).toContain('Users/.resources/List users.resources/examples/OK.example.yaml');
    expect(files['Users/List users.request.yaml']).toMatch(
      /examples: \.\/\.resources\/List users\.resources\/examples\norder: 1000\n$/
    );
    expect(files['.resources/definition.yaml']).toMatch(
      /^\$kind: collection\nname: Kitchen Sink\n/
    );
    expect(files['Users/.resources/definition.yaml']).toMatch(/order: 1000\n$/);
    // Deterministic output.
    expect(exportPostmanV3(first).files).toEqual(files);
  });
});

// ── Restura-native collection ────────────────────────────────────────────────

const kv = (key: string, value: string, enabled = true) => ({ id: key, key, value, enabled });

function req(name: string, request: CollectionRequest): CollectionItem {
  return { id: name, name, type: 'request', request };
}

function httpReq(name: string, auth: AuthConfig, extra: Record<string, unknown> = {}) {
  return req(name, {
    id: name,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: [kv('Accept', 'application/json'), kv('X-Off', '1', false)],
    params: [kv('page', '1'), kv('debug', 'yes', false)],
    body: { type: 'none' },
    auth,
    ...extra,
  } as CollectionRequest);
}

const AUTHS = {
  basic: { type: 'basic', basic: { username: 'u', password: 'basic-pass' } },
  bearer: { type: 'bearer', bearer: { token: 'bearer-tok' } },
  apikey: { type: 'api-key', apiKey: { key: 'X-Key', value: 'apikey-val', in: 'query' } },
  digest: { type: 'digest', digest: { username: 'd', password: 'digest-pass' } },
  aws: {
    type: 'aws-signature',
    awsSignature: { accessKey: 'AK', secretKey: 'aws-secret', region: 'eu-west-1', service: 's3' },
  },
  ntlm: { type: 'ntlm', ntlm: { username: 'n', password: 'ntlm-pass', domain: 'CORP' } },
  oauth1: {
    type: 'oauth1',
    oauth1: { consumerKey: 'ck', consumerSecret: 'oauth1-secret', signatureMethod: 'HMAC-SHA256' },
  },
  oauth2: {
    type: 'oauth2',
    oauth2: {
      accessToken: 'oauth2-tok',
      grantType: 'client_credentials',
      clientId: 'cid',
      clientSecret: 'oauth2-secret',
      tokenUrl: 'https://example.com/token',
      scope: 'read',
    },
  },
  none: { type: 'none' },
} satisfies Record<string, AuthConfig>;

function nativeCollection(): Collection {
  const authItems = Object.entries(AUTHS).map(([k, auth]) => httpReq(`Auth ${k}`, auth));
  return {
    id: 'c',
    name: 'Native',
    description: 'Built in-test',
    auth: { type: 'bearer', bearer: { token: '{{token}}' } },
    variables: [
      kv('baseUrl', 'https://api.example.com'),
      { ...kv('apiSecret', 'var-secret-value'), secret: true },
    ],
    preRequestScript: "rs.variables.set('a', 1);",
    testScript: "rs.test('ok', () => {});",
    items: [
      {
        id: 'f',
        name: 'Auth',
        type: 'folder',
        auth: AUTHS.basic,
        preRequestScript: "console.log('folder');",
        variables: [kv('folderVar', '1')],
        items: authItems,
      },
      httpReq('Inherits', { type: 'bearer', bearer: { token: '{{token}}' } }),
      httpReq('WSSE', { type: 'wsse', wsse: { username: 'w', password: 'wsse-pass' } }),
      httpReq('JSON body', AUTHS.none, {
        method: 'POST',
        body: { type: 'json', raw: '{"a":1}' },
        settings: { verifySsl: false, followRedirects: false, maxRedirects: 3, timeout: 5000 },
        description: 'Creates things',
      }),
      httpReq('Form', AUTHS.none, {
        method: 'POST',
        body: {
          type: 'form-data',
          formData: [
            { ...kv('name', 'Ada'), type: 'text' },
            { ...kv('avatar', ''), type: 'file', fileName: 'a.png' },
          ],
        },
      }),
      httpReq('Urlencoded', AUTHS.none, {
        method: 'POST',
        body: { type: 'x-www-form-urlencoded', formData: [{ ...kv('q', 'x'), type: 'text' }] },
      }),
      httpReq('Protobuf', AUTHS.none, { method: 'POST', body: { type: 'protobuf', raw: 'x' } }),
      req('GraphQL', {
        id: 'g',
        name: 'GraphQL',
        type: 'http',
        method: 'POST',
        url: 'https://api.example.com/graphql',
        headers: [],
        params: [],
        body: { type: 'graphql', raw: '{ me { id } }', graphqlVariables: '{"x":1}' },
        auth: AUTHS.none,
        testScript: "rs.test('gql', () => {});",
      }),
      req('Greeter', {
        id: 'grpc',
        name: 'Greeter',
        type: 'grpc',
        methodType: 'unary',
        url: 'grpc.example.com:443',
        service: 'helloworld.Greeter',
        method: 'SayHello',
        metadata: [kv('x-trace', '1')],
        message: '{"name":"Ada"}',
        auth: AUTHS.none,
      }),
      req('Events', {
        id: 'sse',
        name: 'Events',
        type: 'sse',
        url: 'https://api.example.com/events',
        headers: [],
        params: [],
        auth: AUTHS.none,
      }),
      req('Remote MCP', {
        id: 'mcp',
        name: 'Remote MCP',
        type: 'mcp',
        url: 'https://mcp.example.com/mcp',
        transport: 'http-sse',
        headers: [kv('X-Team', 'core')],
        auth: AUTHS.none,
        defaultMethod: 'tools/list',
        defaultParams: '{}',
      }),
      req('Local MCP', {
        id: 'mcp2',
        name: 'Local MCP',
        type: 'mcp',
        url: '',
        transport: 'stdio',
        stdio: {
          command: 'npx',
          args: ['-y', 'server everything'],
          env: [{ ...kv('TOKEN', 'env-secret'), secret: true }],
        },
        headers: [],
        auth: AUTHS.none,
      }),
      req('Sensors', {
        id: 'mqtt',
        name: 'Sensors',
        type: 'mqtt',
        connection: {
          brokerUrl: 'mqtt://broker.example.com:1883',
          protocolVersion: 5,
          clientId: 'restura-1',
          keepalive: 30,
          cleanStart: false,
          connectTimeout: 10000,
          autoReconnect: false,
          username: 'mqtt-user',
        },
        publish: { topic: 'sensors/temp', payload: '21', qos: 1, retain: true },
        subscribe: { topicFilter: 'sensors/#', qos: 1 },
        templates: [
          { name: 'Humidity', topic: 'sensors/hum', payload: '40', qos: 0, retain: false },
        ],
      }),
      req('Produce', {
        id: 'kafka',
        name: 'Produce',
        type: 'kafka',
        connection: {
          bootstrapBrokers: ['kafka-1:9092'],
          clientId: '',
          securityProtocol: 'PLAINTEXT',
          acks: -1,
          compression: 'gzip',
          idempotent: false,
        },
        produce: {
          topic: 'orders',
          key: 'o-1',
          keyEncoding: 'utf8',
          value: '{"id":1}',
          valueEncoding: 'json',
          headers: [kv('source', 'restura')],
          partition: 2,
        },
        consume: { groupId: '', topics: [], mode: 'committed' },
      }),
      req('Consume', {
        id: 'kafka2',
        name: 'Consume',
        type: 'kafka',
        connection: {
          bootstrapBrokers: ['kafka-1:9092'],
          clientId: '',
          securityProtocol: 'PLAINTEXT',
          acks: 1,
          compression: 'none',
          idempotent: false,
        },
        produce: {
          topic: '',
          key: '',
          keyEncoding: 'utf8',
          value: '',
          valueEncoding: 'utf8',
          headers: [],
        },
        consume: { groupId: '', topics: ['orders'], mode: 'earliest' },
      }),
    ],
  };
}

function find(items: CollectionItem[], name: string): CollectionItem | undefined {
  for (const it of items) {
    if (it.name === name) return it;
    const nested = it.items ? find(it.items, name) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

describe('Postman v3 export — Restura-native collection', () => {
  it('every protocol and auth type round-trips; lossy items are reported', () => {
    const source = nativeCollection();
    const { out, again } = roundTrip(source);
    const constructs = out.report.entries.map((e) => `${e.itemName}:${e.construct}`);
    expect(constructs).toEqual(
      expect.arrayContaining([
        'Native:secret-variable',
        'Auth:folder-variables',
        'WSSE:wsse-auth',
        'JSON body:restura-settings',
        'Form:form-file',
        'Protobuf:body-unsupported',
        'Events:sse-request',
        'Sensors:mqtt-extras',
      ])
    );
    // SSE is dropped from the files; everything else comes back.
    expect(find(again.items, 'Events')).toBeUndefined();
    for (const name of Object.keys(AUTHS)) {
      const before = find(source.items, `Auth ${name}`)?.request as { auth: AuthConfig };
      const after = find(again.items, `Auth ${name}`)?.request as { auth: AuthConfig };
      expect(after.auth, name).toEqual(before.auth);
    }
    const strip = (c: Collection) => {
      const n = normalise(c) as Record<string, unknown>;
      return JSON.parse(JSON.stringify(n)) as unknown;
    };
    const a = strip(again) as Collection;
    const b = strip(source) as Collection;
    // Known, reported losses.
    expect(a.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true },
      { key: 'apiSecret', value: '', enabled: true },
    ]);
    expect(find(a.items, 'Auth')?.variables).toBeUndefined();
    expect((find(a.items, 'WSSE')?.request as { auth: AuthConfig }).auth).toEqual({ type: 'none' });
    expect(a.preRequestScript).toBe(b.preRequestScript);
    expect(a.testScript).toBe(b.testScript);
    for (const name of [
      'Inherits',
      'JSON body',
      'Urlencoded',
      'GraphQL',
      'Greeter',
      'Remote MCP',
      'Produce',
      'Consume',
    ]) {
      const before = find(b.items, name)?.request as unknown as Record<string, unknown>;
      const after = find(a.items, name)?.request as unknown as Record<string, unknown>;
      if (name === 'JSON body') {
        expect(after.settings).toEqual({
          verifySsl: false,
          followRedirects: false,
          maxRedirects: 3,
        });
        expect({ ...after, settings: undefined }).toEqual({ ...before, settings: undefined });
      } else expect(after, name).toEqual(before);
    }
    const local = find(a.items, 'Local MCP')?.request as unknown as {
      stdio: { command: string; args: string[]; env: Array<{ key: string; value: string }> };
    };
    expect(local.stdio.command).toBe('npx');
    expect(local.stdio.args).toEqual(['-y', 'server everything']);
    const mqtt = find(a.items, 'Sensors')?.request as unknown as Record<string, unknown>;
    const mqttBefore = find(b.items, 'Sensors')?.request as unknown as Record<string, unknown>;
    expect({ ...mqtt, connection: undefined }).toEqual({ ...mqttBefore, connection: undefined });
  });

  it('streamable-HTTP MCP is approximated as SSE and reported', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [
        req('M', {
          id: 'm',
          name: 'M',
          type: 'mcp',
          url: 'https://m.example.com',
          transport: 'streamable-http',
          headers: [],
          auth: AUTHS.none,
          testScript: 'x',
        }),
      ],
    };
    const { out, again } = roundTrip(c);
    expect(out.report.entries.map((e) => e.construct)).toEqual(['mcp-scripts', 'mcp-transport']);
    expect((again.items[0]?.request as { transport: string }).transport).toBe('http-sse');
  });
});

// ── secrets ─────────────────────────────────────────────────────────────────

const PLAINTEXTS = [
  'basic-pass',
  'bearer-tok',
  'apikey-val',
  'digest-pass',
  'aws-secret',
  'ntlm-pass',
  'oauth1-secret',
  'oauth2-tok',
  'oauth2-secret',
  'wsse-pass',
  'var-secret-value',
  'env-secret',
  'hawk-key-value',
  'example-cookie',
];

describe('Postman v3 export — secrets', () => {
  it('without "include secrets" no plaintext reaches any file; secret vars are empty + reported', () => {
    const source = nativeCollection();
    // Bag-only credentials (unsupported hawk auth, saved-response headers).
    const hawk = httpReq('Hawk', { type: 'none' });
    Object.assign(hawk, {
      _postman: {
        auth: {
          type: 'hawk',
          hawk: [
            { key: 'authId', value: 'id' },
            { key: 'authKey', value: 'hawk-key-value' },
          ],
        },
        response: [
          {
            name: 'OK',
            originalRequest: { method: 'GET', url: 'https://x', header: [] },
            code: 200,
            status: 'OK',
            header: [{ key: 'Set-Cookie', value: 'example-cookie' }],
            body: '[]',
          },
        ],
      },
    });
    source.items.push(hawk);
    const out = exportPostmanV3(redactCollectionSecrets(source));
    expectValid(out.tree);
    const all = Object.values(out.files).join('\n');
    for (const secret of PLAINTEXTS) expect(all, secret).not.toContain(secret);
    expect(out.report.entries).toContainEqual(
      expect.objectContaining({ construct: 'secret-variable', kind: 'emptied', itemName: 'Native' })
    );
    expect(out.files['.resources/definition.yaml']).toContain("key: apiSecret\n    value: ''");
    // The hawk auth itself still round-trips (shape, not secret).
    expect(out.files['Hawk.request.yaml']).toMatch(/type: hawk/);
  });

  it('a kept form body (file rows) restored from the sidecar has its secret text rows blanked', () => {
    const form = httpReq(
      'Login',
      { type: 'none' },
      { method: 'POST', body: { type: 'form-data', formData: [] } }
    );
    Object.assign(form, {
      _postman: {
        body: {
          type: 'formdata',
          content: [
            { type: 'text', key: 'password', value: 'form-pass-plain' },
            { type: 'text', key: 'user', value: 'ada' },
            { type: 'file', key: 'avatar', src: '/tmp/a.png' },
          ],
        },
      },
    });
    const c: Collection = { id: 'c', name: 'C', items: [form] };
    expect(countCollectionInlineSecrets(c)).toBe(1);
    const out = exportPostmanV3(redactCollectionSecrets(c));
    const file = out.files['Login.request.yaml'] ?? '';
    expect(file).not.toContain('form-pass-plain');
    expect(file).toContain('value: ada');
    expect(file).toContain('src: /tmp/a.png');
  });

  it('secret variables are emptied even when secrets are included; handles never resolve', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      variables: [{ ...kv('s', 'plain-secret'), secret: true }],
      items: [
        httpReq('H', {
          type: 'bearer',
          bearer: { token: { kind: 'handle', id: 'h1', label: 'tok' } },
        }),
      ],
    };
    const out = exportPostmanV3(c);
    const all = Object.values(out.files).join('\n');
    expect(all).not.toContain('plain-secret');
    expect(all).not.toContain('h1');
    expect(out.report.entries.map((e) => e.construct)).toEqual([
      'secret-handle',
      'secret-variable',
    ]);
  });
});

// ── filenames ───────────────────────────────────────────────────────────────

describe('Postman v3 export — filename safety', () => {
  it('sanitises separators, reserved characters, dot segments, reserved and long names', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeFileName('..')).toBe('__');
    expect(safeFileName('../../etc/passwd')).toBe('___.._etc_passwd');
    expect(safeFileName('.resources')).toBe('_resources');
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('  ')).toBe('Untitled');
    expect(safeFileName('trailing. ')).toBe('trailing');
    expect(Array.from(safeFileName('x'.repeat(500))).length).toBe(80);
  });

  it('case-only collisions get unique files and keep their real names on re-import', () => {
    const names = ['Users', 'users', 'USERS', 'a/b', '..', 'x'.repeat(300)];
    const c: Collection = {
      id: 'c',
      name: 'Weird / Name',
      items: [
        ...names.map((n) => httpReq(n, { type: 'none' })),
        { id: 'f1', name: 'Dir', type: 'folder', items: [httpReq('in', { type: 'none' })] },
        { id: 'f2', name: 'dir', type: 'folder', items: [httpReq('in', { type: 'none' })] },
      ],
    };
    const { out, again } = roundTrip(c);
    const paths = Object.keys(out.files);
    for (const p of paths) {
      expect(p).not.toMatch(/(^|\/)\.\.(\/|$)/);
      expect(p.startsWith('/')).toBe(false);
      expect(p).not.toContain('\\');
    }
    const lower = paths.map((p) => p.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    expect(paths).toEqual(
      expect.arrayContaining([
        'Users.request.yaml',
        'users (2).request.yaml',
        'USERS (3).request.yaml',
      ])
    );
    expect(again.name).toBe('Weird / Name');
    expect(again.items.map((i) => i.name)).toEqual([...names, 'Dir', 'dir']);
  });
});
