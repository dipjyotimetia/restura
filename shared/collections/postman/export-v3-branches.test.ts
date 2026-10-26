import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import type { AuthConfig, Collection, CollectionItem, CollectionRequest } from '../../types';
import { exportPostmanV3, exportPostmanV3Tree } from './export-v3';
import { writePostmanV3Files } from './export-v3-files';
import { joinCommandLine } from './export-v3-protocols';
import { importPostmanV3Files } from './index';
import { splitCommandLine } from './parse-v3-protocols';

/** Per-construct coverage of the v3 serializer's inverse mappings and sidecar restores. */

const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v3.0.0/schema.json'), 'utf8')
) as object;
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

const kv = (key: string, value: string, extra: Record<string, unknown> = {}) => ({
  id: key,
  key,
  value,
  enabled: true,
  ...extra,
});

function item(name: string, request: unknown, sidecar?: unknown): CollectionItem {
  const it: CollectionItem = {
    id: name,
    name,
    type: 'request',
    request: request as CollectionRequest,
  };
  if (sidecar) Object.assign(it, { _postman: sidecar });
  return it;
}

function http(extra: Record<string, unknown> = {}) {
  return {
    id: 'h',
    name: 'h',
    type: 'http',
    method: 'GET',
    url: 'https://x.example.com/a',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...extra,
  };
}

function run(items: CollectionItem[], extra: Partial<Collection> = {}) {
  const c: Collection = { id: 'c', name: 'C', items, ...extra };
  const { tree, report } = exportPostmanV3Tree(c);
  const ok = validate(tree);
  expect(ok ? [] : validate.errors?.slice(0, 3)).toEqual([]);
  const items0 = (tree.items ?? []) as Array<Record<string, unknown>>;
  return { tree, report, items: items0, constructs: report.entries.map((e) => e.construct) };
}

describe('auth inverse mapping', () => {
  it('maps optional OAuth1 / OAuth2 / NTLM fields and reports unexportable ones', () => {
    const oauth1: AuthConfig = {
      type: 'oauth1',
      oauth1: {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        accessToken: 't',
        accessTokenSecret: 'ts',
        realm: 'r',
        nonce: 'n',
        timestamp: '1',
        addParamsToBody: true,
      },
    };
    const oauth2: AuthConfig = {
      type: 'oauth2',
      oauth2: {
        accessToken: 'a',
        refreshToken: 'rt',
        grantType: 'device_code',
        deviceAuthorizationUrl: 'https://d',
        issuer: 'i',
        scopes: ['s'],
        expiresAt: 1,
        authorizationUrl: 'https://auth',
        redirectUri: 'https://cb',
        username: 'u',
        password: 'p',
        tokenType: 'Bearer',
      },
    };
    const ntlm: AuthConfig = {
      type: 'ntlm',
      ntlm: { username: 'u', password: 'p', workstation: 'w' },
    };
    const { items, constructs } = run([
      item('o1', http({ auth: oauth1 })),
      item('o2', http({ auth: oauth2 })),
      item('nt', http({ auth: ntlm })),
      item(
        'ext',
        http({
          auth: {
            type: 'bearer',
            bearer: {
              token: { kind: 'external', provider: 'vault', profileId: 'p', secretId: 's' },
            },
          },
        })
      ),
      item(
        'inl',
        http({ auth: { type: 'bearer', bearer: { token: { kind: 'inline', value: 'v' } } } })
      ),
      item('empty', http({ auth: { type: 'basic' } })),
    ]);
    const creds = (i: number) =>
      Object.fromEntries(
        (items[i]?.auth as { credentials: Array<{ key: string; value: unknown }> }).credentials.map(
          (c) => [c.key, c.value]
        )
      );
    expect(creds(0)).toMatchObject({ token: 't', tokenSecret: 'ts', addParamsToHeader: 'false' });
    expect(creds(1)).toMatchObject({
      authUrl: 'https://auth',
      redirect_uri: 'https://cb',
      password: 'p',
    });
    expect(creds(1).grant_type).toBeUndefined();
    expect(creds(2)).toEqual({ username: 'u', password: 'p', workstation: 'w' });
    expect(creds(3)).toEqual({ token: '' });
    expect(creds(4)).toEqual({ token: 'v' });
    expect(creds(5)).toEqual({ username: '', password: '' });
    expect(constructs).toEqual(['auth-fields', 'secret-handle']);
  });

  it('restores unsupported / approximated auth and multi-auth from the sidecar; enforces per-kind enums', () => {
    const { items, tree, constructs } = run(
      [
        item('hawk', http(), { auth: { type: 'hawk', hawk: { authId: 'id' } } }),
        item('o2', http({ auth: { type: 'oauth2', oauth2: { accessToken: '' } } }), {
          auth: { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'implicit' }] },
          authSets: [{ type: 'oauth2', credentialKeys: [] }],
        }),
        item('grpc digest', {
          id: 'g',
          name: 'g',
          type: 'grpc',
          methodType: 'unary',
          url: 'x:1',
          service: '',
          method: 'M',
          metadata: [],
          message: '',
          auth: { type: 'digest', digest: { username: 'u', password: 'p' } },
        }),
        item('bad sidecar', http({ auth: { type: 'bearer', bearer: { token: 'x' } } }), {
          auth: 'garbage',
        }),
      ],
      { auth: { type: 'none' } }
    );
    expect(tree.auth).toEqual({ type: 'noauth' });
    expect(items[0]?.auth).toEqual({ type: 'hawk', credentials: [{ key: 'authId', value: 'id' }] });
    expect(items[1]?.auth).toMatchObject({
      credentials: expect.arrayContaining([{ key: 'grant_type', value: 'implicit' }]),
    });
    expect(items[2]?.auth).toEqual({ type: 'noauth' });
    expect(items[2]?.methodPath).toBe('M');
    expect(constructs).toEqual(['multi-auth', 'auth-unsupported-for-kind']);
  });
});

describe('HTTP request details', () => {
  it('maps every settings field, bodies, method / path variables / examples from the sidecar', () => {
    const settings = {
      httpVersion: 'http1.1',
      verifySsl: true,
      followOriginalMethod: true,
      followAuthHeader: false,
      stripReferer: true,
      encodeUrlAutomatically: false,
      disableCookieJar: true,
      serverCipherOrder: true,
      cipherSuites: 'A:B',
      proxy: { enabled: false },
    };
    const { items, constructs } = run([
      item(
        's1',
        http({
          settings,
          url: 'https://x.example.com/a#frag',
          params: [kv('q', ''), kv('r', '1')],
        }),
        {
          settings: { insecureHTTPParser: true, bogus: 1 },
        }
      ),
      item('s2', http({ settings: { httpVersion: 'http2' } })),
      item('s3', http({ settings: { httpVersion: 'auto' } })),
      item('s4', http({ settings: { httpVersion: 'h2c-prior-knowledge' } })),
      item('m', http({ url: 'https://x.example.com/a?z=1', params: [kv('b', '2')] }), {
        method: 'PURGE',
        urlVariable: [{ key: 'id', value: '', description: 'the id', disabled: true }, 'junk'],
        response: [
          {
            name: 'OK',
            originalRequest: {
              method: 'GET',
              url: 'https://x',
              header: [{ key: 'A', value: '1', disabled: true }],
            },
            code: 200,
            status: 'OK',
            header: [{ key: 'B', value: '2' }, { nokey: true }],
            body: '{}',
          },
          { originalRequest: 'x' },
        ],
      }),
      item('bin', http({ method: 'PUT', body: { type: 'binary' } }), {
        body: { type: 'file', content: { src: '/tmp/a.bin', other: 1 } },
      }),
      item('bin2', http({ method: 'PUT', body: { type: 'binary' } })),
      item(
        'form',
        http({
          method: 'POST',
          body: { type: 'form-data', formData: [{ ...kv('f', ''), type: 'file' }] },
        }),
        {
          body: { type: 'formdata', content: [{ type: 'file', key: 'f', src: '/tmp/f' }] },
        }
      ),
      item(
        'form2',
        http({
          method: 'POST',
          body: {
            type: 'form-data',
            formData: [
              {
                ...kv('t', 'v', { description: 'd', enabled: false }),
                type: 'text',
                contentType: 'text/plain',
              },
            ],
          },
        })
      ),
      item('mm', http({ method: 'POST', body: { type: 'multipart-mixed' } })),
      item('raw', http({ method: 'POST', body: { type: 'xml' } })),
      item(
        'gql get',
        http({
          method: 'GET',
          body: { type: 'graphql', graphqlOperationName: 'Op' },
          graphqlSubscriptionProtocol: 'auto',
        })
      ),
      item('gql native', http({ method: 'POST', body: { type: 'graphql' } }), {
        settings: { disabledSystemHeaders: ['accept'] },
        schema: { source: 'auto' },
      }),
    ]);
    expect(items[0]?.settings).toEqual({
      protocolVersion: 'http1',
      strictSSL: true,
      followOriginalHttpMethod: true,
      followAuthorizationHeader: false,
      removeRefererHeaderOnRedirect: true,
      disableUrlEncoding: true,
      disableCookies: true,
      tlsPreferServerCiphers: true,
      tlsCipherSelection: ['A', 'B'],
      insecureHTTPParser: true,
    });
    expect(items[0]?.url).toBe('https://x.example.com/a?q&r=1#frag');
    expect(items[1]?.settings).toEqual({ protocolVersion: 'http2' });
    expect(items[2]?.settings).toEqual({ protocolVersion: 'auto' });
    expect(items[3]?.settings).toBeUndefined();
    expect(items[4]).toMatchObject({ method: 'PURGE', url: 'https://x.example.com/a?z=1&b=2' });
    expect(items[4]?.pathVariables).toEqual([
      { key: 'id', value: '', disabled: true, description: 'the id' },
    ]);
    expect((items[4]?.examples as unknown[]).length).toBe(2);
    expect(items[5]?.body).toEqual({ type: 'file', content: { src: '/tmp/a.bin' } });
    expect(items[6]?.body).toEqual({ type: 'file', content: {} });
    expect(items[7]?.body).toEqual({
      type: 'formdata',
      content: [{ type: 'file', key: 'f', src: '/tmp/f' }],
    });
    expect(items[8]?.body).toEqual({
      type: 'formdata',
      content: [
        {
          type: 'text',
          key: 't',
          value: 'v',
          contentType: 'text/plain',
          description: 'd',
          disabled: true,
        },
      ],
    });
    expect(items[9]?.body).toBeUndefined();
    expect(items[10]?.body).toEqual({ type: 'xml', content: '' });
    expect(items[11]).toMatchObject({
      $kind: 'http-request',
      body: { type: 'graphql', content: { query: '', operationName: 'Op' } },
    });
    expect(items[12]).toMatchObject({
      $kind: 'graphql-request',
      settings: { disabledSystemHeaders: ['accept'] },
      schema: { source: 'auto' },
    });
    expect(constructs).toEqual([
      'restura-settings',
      'restura-settings',
      'binary-body',
      'body-unsupported',
      'graphql-extras',
    ]);
  });
});

describe('gRPC, MCP, MQTT, Kafka details', () => {
  it('reports Restura-only gRPC data and restores settings / examples notes', () => {
    const { items, constructs } = run([
      item(
        'g',
        {
          id: 'g',
          name: 'g',
          type: 'grpc',
          methodType: 'server-streaming',
          url: 'x:1',
          service: 'S',
          method: 'M',
          metadata: [kv('a', '1')],
          message: '{}',
          auth: { type: 'none' },
          timeout: 1,
          wireProtocol: 'grpc-web',
          schema: { source: 'reflection' },
          preRequestScript: 'a',
          testScript: 'b',
        },
        { settings: { secureConnection: true, nope: 1 }, response: [{}] }
      ),
    ]);
    expect(items[0]).toMatchObject({ methodPath: 'S/M', settings: { secureConnection: true } });
    expect(items[0]?.scripts).toEqual([
      { type: 'beforeInvoke', code: 'a' },
      { type: 'afterResponse', code: 'b' },
    ]);
    expect(constructs).toEqual(['grpc-extras', 'examples']);
  });

  it('MCP: settings restore per transport, params, quoting, cwd', () => {
    const mcp = (name: string, extra: Record<string, unknown>) => ({
      id: name,
      name,
      type: 'mcp',
      url: 'https://m',
      transport: 'http-sse',
      headers: [],
      auth: { type: 'none' },
      ...extra,
    });
    const { items, constructs } = run([
      item('sse', mcp('sse', { defaultMethod: 'm', defaultParams: 'not json' }), {
        settings: { version: 'auto', strictSSL: false, other: 1 },
      }),
      item(
        'stdio',
        mcp('stdio', {
          transport: 'stdio',
          stdio: {
            command: 'run',
            args: ['say "hi"', 'it\'s "x"'],
            cwd: '/tmp',
            env: [{ ...kv('K', 'v'), secretRef: { kind: 'handle', id: 'h' } }],
          },
          defaultMethod: 'm',
        }),
        { settings: { requestTimeout: 5, strictSSL: true } }
      ),
      item('nostdio', mcp('nostdio', { transport: 'stdio' })),
    ]);
    expect(items[0]).toMatchObject({
      message: '{"jsonrpc":"2.0","id":1,"method":"m"}',
      settings: { version: 'auto', strictSSL: false },
    });
    expect(items[1]).toMatchObject({
      settings: { requestTimeout: 5 },
      env: [{ key: 'K', value: '' }],
    });
    expect(items[2]?.command).toBeUndefined();
    expect(constructs).toEqual(['mcp-params', 'mcp-stdio-extras', 'secret-handle']);
  });

  it('joinCommandLine is the inverse of splitCommandLine where possible', () => {
    for (const argv of [['a', 'b c'], ['x', 'say "hi"'], ['', 'y'], ["it's"]]) {
      const { line, lossless } = joinCommandLine(argv);
      expect(lossless).toBe(true);
      expect(splitCommandLine(line)).toEqual(argv);
    }
    expect(joinCommandLine([`a"b'c`]).lossless).toBe(false);
  });

  it('MQTT: extras reported, leftovers and bag-only auth restored, empty publish skipped', () => {
    const conn = {
      brokerUrl: 'mqtt://b',
      protocolVersion: 4,
      clientId: '',
      keepalive: 60,
      cleanStart: true,
      connectTimeout: 1000,
      autoReconnect: true,
    };
    const { items, constructs } = run([
      item(
        'm1',
        {
          id: 'm1',
          name: 'm1',
          type: 'mqtt',
          connection: {
            ...conn,
            tls: {},
            sessionExpiryInterval: 1,
            lwt: { topic: 't', payload: 'p', qos: 1, retain: false },
          },
          publish: { topic: '', payload: '', qos: 0, retain: false, contentType: 'x' },
          subscribe: { topicFilter: '', qos: 0 },
          templates: [],
        },
        {
          leftovers: {
            topics: [{ name: 'extra' }],
            settings: { strictSSL: false, x: 1 },
            properties: { sessionExpiryInterval: 3 },
          },
          authBagOnly: true,
          auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }] },
          response: [{}],
        }
      ),
      item(
        'm2',
        {
          id: 'm2',
          name: 'm2',
          type: 'mqtt',
          connection: conn,
          publish: { topic: '', payload: '', qos: 0, retain: false },
          subscribe: { topicFilter: 's', qos: 2 },
          templates: [{ name: '', topic: 't', payload: 'p', qos: 0, retain: false }],
        },
        { authBagOnly: true, auth: { type: 'noauth' } }
      ),
    ]);
    expect(items[0]).toMatchObject({
      topics: [{ name: 'extra' }],
      settings: { strictSSL: false },
      properties: { sessionExpiryInterval: 3 },
      auth: { type: 'basic', credentials: [{ key: 'username', value: 'u' }] },
      lastWill: { topic: 't', payload: 'p', qos: 1, retain: false },
    });
    expect(items[0]?.messages).toBeUndefined();
    expect((items[1]?.messages as Array<{ name: string }>).map((m) => m.name)).toEqual([
      'Message',
      'Message',
    ]);
    expect(items[1]?.auth).toEqual({ type: 'noauth' });
    expect(constructs).toEqual(['mqtt-extras', 'examples']);
  });

  it('Kafka: extras, mixed / consumer modes, leftovers, scripts, bag-only auth', () => {
    const base = {
      type: 'kafka',
      connection: {
        bootstrapBrokers: ['k:1'],
        clientId: 'cid',
        securityProtocol: 'SASL_SSL',
        sasl: { mechanism: 'PLAIN' },
        registry: { url: 'r' },
        tls: { caPath: '/ca', rejectUnauthorized: false },
        idempotent: true,
        transactionalId: 't',
        acks: 0,
        compression: 'none',
      },
      produce: {
        topic: 'p',
        key: '',
        keyEncoding: 'base64',
        value: '',
        valueEncoding: 'utf8',
        headers: [],
      },
      consume: { groupId: 'g', topics: ['c'], mode: 'committed' },
      description: 'd',
    };
    const consumer = {
      ...base,
      produce: { ...base.produce, topic: '' },
      consume: { groupId: '', topics: ['c'], mode: 'latest' },
      description: undefined,
    };
    const { items, constructs } = run([
      item(
        'mixed',
        { ...base, id: 'k1', name: 'mixed' },
        {
          leftovers: { messages: [{ $kind: 'kafka-message', name: 'm2', topic: 't2' }] },
          scripts: [{ type: 'beforeProduce', code: 'x' }, { type: 'nope', code: 'y' }, 'junk'],
          authBagOnly: true,
          auth: { type: 'sasl', sasl: [{ key: 'username', value: 'u' }] },
        }
      ),
      item(
        'consumer',
        { ...consumer, id: 'k2', name: 'consumer' },
        { leftovers: { stopAfter: { maxRecords: 1 } } }
      ),
      item('committed', {
        ...consumer,
        id: 'k3',
        name: 'committed',
        consume: { groupId: '', topics: ['c'], mode: 'committed' },
      }),
    ]);
    expect(items[0]).toMatchObject({
      mode: 'producer',
      acknowledgements: 'none',
      settings: { secureConnection: true, strictSSL: false },
      scripts: [{ type: 'beforeProduce', code: 'x' }],
      auth: { type: 'sasl' },
    });
    expect((items[0]?.messages as unknown[]).length).toBe(2);
    expect(items[1]).toMatchObject({
      mode: 'consumer',
      startPosition: { type: 'end' },
      stopAfter: { maxRecords: 1 },
    });
    expect(items[2]).toMatchObject({ startPosition: { type: 'end' } });
    expect(constructs).toEqual([
      'kafka-extras',
      'description',
      'kafka-mode',
      'kafka-extras',
      'kafka-extras',
      'kafka-mode',
    ]);
  });
});

describe('containers, placeholders, scripts, variables', () => {
  it('restores folder description / auth, placeholders, root uses, shadowed scripts and vault sources', () => {
    const folder: CollectionItem = {
      id: 'f',
      name: 'F',
      type: 'folder',
      items: [item('in', http())],
      contractSpec: { source: 'url', url: 'x' },
      testScript: 't',
    };
    Object.assign(folder, {
      _postman: {
        description: 'about F',
        auth: { type: 'jwt', jwt: [{ key: 'algorithm', value: 'HS256' }] },
        event: [
          { type: 'http:afterResponse', code: 'old', extra: 1 },
          { type: 'http:beforeRequest', code: 'pre-old' },
        ],
        scripts: [{ type: 'grpc:beforeInvoke', code: 'g' }],
      },
    });
    const placeholder = (kind: string, auth?: unknown): CollectionItem =>
      Object.assign(
        { id: kind, name: `${kind} (x)`, type: 'folder' as const, items: [] },
        {
          _postman: {
            item: { $kind: kind, name: kind, url: 'wss://x' },
            ...(auth ? { authBagOnly: true, auth } : {}),
          },
        }
      );
    const { tree, items, constructs } = run(
      [
        folder,
        placeholder('websocket-request', { type: 'bearer', bearer: [{ key: 'token', value: '' }] }),
        placeholder('llm-request', { type: 'hawk', hawk: [] }),
        placeholder('socket.io-request'),
        Object.assign(
          { id: 'e', name: 'Empty', type: 'folder' as const, items: [] },
          { _postman: { item: 'x' } }
        ),
        item('sse', {
          id: 's',
          name: 's',
          type: 'sse',
          url: 'x',
          headers: [],
          params: [],
          auth: { type: 'none' },
        }),
        { id: 'n', name: 'no request', type: 'request' },
        item('weird', { id: 'w', name: 'w', type: 'websocket' }),
      ],
      {
        contractSpec: { source: 'url', url: 'x' },
        variables: [
          { ...kv('vault', ''), secret: true },
          { ...kv('off', 'v', { enabled: false, description: 'd' }) },
          {
            ...kv('ref', '', { enabled: false, description: 'd' }),
            secretRef: { kind: 'handle', id: 'h' },
          },
        ],
      }
    );
    Object.assign(tree, {});
    expect(items[0]).toMatchObject({
      description: 'about F',
      auth: { type: 'jwt' },
      scripts: [
        { type: 'http:beforeRequest', code: 'pre-old' },
        { type: 'http:afterResponse', code: 'old' },
        { type: 'http:afterResponse', code: 't' },
        { type: 'grpc:beforeInvoke', code: 'g' },
      ],
    });
    expect(items[1]).toEqual({
      $kind: 'websocket-request',
      name: 'websocket-request',
      url: 'wss://x',
      auth: { type: 'bearer', credentials: [{ key: 'token', value: '' }] },
    });
    expect(items[2]?.auth).toBeUndefined();
    expect(items[3]?.$kind).toBe('socket.io-request');
    expect(items[4]).toMatchObject({ $kind: 'collection', name: 'Empty', items: [] });
    expect(items).toHaveLength(5);
    expect(tree.variables).toEqual([
      { key: 'vault', value: '' },
      { key: 'off', value: 'v', disabled: true, description: 'd' },
      { key: 'ref', value: '', disabled: true, description: 'd' },
    ]);
    expect(constructs).toEqual([
      'contract-spec',
      'contract-spec',
      'sse-request',
      'secret-variable',
      'secret-variable',
    ]);
  });

  it('a vault source kept at import round-trips as a v3 secret variable', () => {
    const c: Collection = {
      id: 'c',
      name: 'C',
      items: [],
      variables: [{ ...kv('tok', '', { description: 'd', enabled: false }), secret: true }],
    };
    Object.assign(c, {
      _postman: {
        uses: { environment: ['e1'] },
        variable: [
          {
            key: 'tok',
            secret: true,
            source: { provider: 'postman', postman: { type: 'local', secretId: 'tok' } },
          },
          'junk',
        ],
      },
    });
    const { tree, report } = exportPostmanV3Tree(c);
    expect(validate(tree)).toBe(true);
    expect(tree.variables).toEqual([
      {
        key: 'tok',
        secret: true,
        disabled: true,
        description: 'd',
        source: { provider: 'postman', postman: { type: 'local', secretId: 'tok' } },
      },
    ]);
    expect(tree.uses).toEqual({ environment: ['e1'] });
    expect(report.entries).toEqual([]);
    const again = importPostmanV3Files(exportPostmanV3(c).files).collection;
    expect(again.variables?.[0]).toMatchObject({ key: 'tok', secret: true, value: '' });
  });

  it('honours a custom script transform and default names', () => {
    const c: Collection = {
      id: 'c',
      name: '',
      items: [item('', http({ name: '', preRequestScript: 'rs.x' }))],
    };
    const { tree } = exportPostmanV3Tree(c, { transformScript: (s) => `//${s}` });
    expect(tree.name).toBe('Untitled Collection');
    expect((tree.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 'Untitled',
      scripts: [{ type: 'beforeRequest', code: '//rs.x' }],
    });
  });
});

describe('file layout shorthands', () => {
  it('keeps row arrays when the map shorthand would lose data', () => {
    const files = writePostmanV3Files({
      $kind: 'collection',
      name: 'C',
      items: [
        {
          $kind: 'http-request',
          name: 'R',
          queryParams: [
            { key: 'a', value: '1' },
            { key: 'a', value: '2' },
          ],
          pathVariables: [{ key: 'id', value: '1', disabled: true }],
          auth: [
            {
              id: 'x',
              name: 'x',
              type: 'basic',
              credentials: [
                { key: 'k', value: 1 },
                { key: 'k', value: 2 },
              ],
            },
            'junk',
          ],
        },
        {
          $kind: 'http-request',
          name: 'Q',
          queryParams: [{ key: '__proto__', value: '1' }],
          pathVariables: [],
        },
        'junk',
        { $kind: 'http-request', examples: [{ $kind: 'http-example' }] },
      ],
    });
    expect(files['R.request.yaml']).toContain('queryParams:\n  - key: a');
    expect(files['R.request.yaml']).toContain('credentials:\n      - key: k');
    expect(files['Q.request.yaml']).toContain('queryParams:\n  - key: __proto__');
    expect(Object.keys(files)).toContain(
      '.resources/Untitled.resources/examples/Untitled.example.yaml'
    );
  });
});

describe('defensive inputs', () => {
  it('auth configs without their blocks, unknown types and sidecar shapes', () => {
    const types = [
      'basic',
      'bearer',
      'api-key',
      'digest',
      'aws-signature',
      'ntlm',
      'oauth1',
      'oauth2',
    ];
    const { items, constructs } = run([
      ...types.map((type) => item(type, http({ auth: { type } }))),
      item('unknown', http({ auth: { type: 'kerberos' } })),
      item(
        'v2.0 map',
        http({ auth: { type: 'oauth2', oauth2: { accessToken: '', clientId: 'c' } } }),
        { auth: { type: 'oauth2', oauth2: { clientId: 'dup', grant_type: 'implicit', nul: null } } }
      ),
      item('array nulls', http(), { auth: { type: 'hawk', hawk: [{ key: 'authKey' }, 'junk'] } }),
      item('no block', http(), { auth: { type: 'edgegrid' } }),
      item(
        'grpc',
        {
          id: 'g',
          name: 'g',
          type: 'grpc',
          methodType: 'unary',
          url: 'x:1',
          service: '',
          method: '',
          metadata: [],
          message: '',
          auth: { type: 'none' },
        },
        { schema: { source: 'auto' } }
      ),
    ]);
    expect(items.slice(0, 8).every((i) => i.auth !== undefined)).toBe(true);
    expect(items[8]?.auth).toBeUndefined();
    expect(items[9]?.auth).toMatchObject({
      credentials: expect.arrayContaining([
        { key: 'clientId', value: 'c' },
        { key: 'grant_type', value: 'implicit' },
        { key: 'nul', value: '' },
      ]),
    });
    expect(items[10]?.auth).toEqual({ type: 'hawk', credentials: [{ key: 'authKey', value: '' }] });
    expect(items[11]?.auth).toEqual({ type: 'edgegrid', credentials: [] });
    expect(items[12]).toMatchObject({ schema: { source: 'auto' } });
    expect(items[12]?.methodPath).toBeUndefined();
    expect(constructs).toEqual([]);
  });

  it('folders without items or names, body / row fallbacks, broker leftovers junk', () => {
    const { items } = run([
      { id: 'f', name: '', type: 'folder' } as CollectionItem,
      item('form', http({ method: 'POST', body: { type: 'form-data' } })),
      item(
        'file',
        http({
          method: 'POST',
          body: { type: 'form-data', formData: [{ ...kv('f', ''), type: 'file' }] },
        })
      ),
      item('urlvar', http(), { urlVariable: [{ key: 'id', value: '1' }] }),
      item(
        'mqtt',
        {
          id: 'm',
          name: 'm',
          type: 'mqtt',
          connection: {
            brokerUrl: 'mqtt://b',
            protocolVersion: 5,
            clientId: 'c',
            keepalive: 1,
            cleanStart: true,
            connectTimeout: 1,
            autoReconnect: true,
          },
          publish: { topic: 't', payload: '', qos: 0, retain: false, userProperties: {} },
          subscribe: { topicFilter: '', qos: 0 },
          templates: [],
        },
        { leftovers: { topics: ['junk'] } }
      ),
      item(
        'kafka',
        {
          id: 'k',
          name: 'k',
          type: 'kafka',
          connection: {
            bootstrapBrokers: [],
            clientId: '',
            securityProtocol: 'PLAINTEXT',
            acks: 1,
            compression: 'none',
            idempotent: false,
            tls: { rejectUnauthorized: true },
          },
          produce: {
            topic: '',
            key: 'k',
            keyEncoding: 'json',
            value: '',
            valueEncoding: 'base64',
            headers: [],
          },
          consume: { groupId: '', topics: [], mode: 'committed' },
        },
        { leftovers: { messages: ['junk'] }, schema: { source: 'auto' } }
      ),
    ]);
    expect(items[0]).toEqual({ name: 'Untitled', $kind: 'collection', items: [] });
    expect(items[1]?.body).toEqual({ type: 'formdata', content: [] });
    expect(items[2]?.body).toEqual({
      type: 'formdata',
      content: [{ type: 'file', key: 'f', src: '' }],
    });
    expect(items[3]?.pathVariables).toEqual([{ key: 'id', value: '1' }]);
    expect(items[4]?.topics).toBeUndefined();
    expect((items[5]?.messages as unknown[]).length).toBe(1);
    expect(items[5]).toMatchObject({ schema: { source: 'auto' }, acknowledgements: 'leader' });
    const files = writePostmanV3Files({
      $kind: 'collection',
      name: 'C',
      auth: { type: 'basic', credentials: ['junk'] },
      items: [{ $kind: 'collection', name: 'lpt1.txt' }],
    });
    expect(files['.resources/definition.yaml']).toContain('credentials:\n    - junk');
    expect(Object.keys(files)).toContain('_lpt1.txt/.resources/definition.yaml');
  });
});

describe('placeholders and empty collections export cleanly', () => {
  it('an empty collection is one root definition', () => {
    const { files } = exportPostmanV3({ id: 'c', name: 'Empty', items: [] });
    expect(files).toEqual({ '.resources/definition.yaml': '$kind: collection\nname: Empty\n' });
  });
});
