import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type {
  CollectionItem,
  GrpcRequest,
  HttpRequest,
  KafkaRequest,
  McpRequest,
  MqttRequest,
  SocketIoRequest,
  WebSocketRequest,
} from '../../types';
import { detectPostmanVersion, importPostmanCollection } from './index';
import { getPostmanSidecar } from './sidecar';
import { unzipPostmanV3Archive } from './v3-archive';
import {
  isPostmanV3FileMap,
  PostmanV3ContainerError,
  readPostmanV3Container,
} from './v3-container';

const FIXTURES = resolve(process.cwd(), 'shared/collections/postman/__fixtures__/v3');

function loadFileMap(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[prefix + relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v3.0.0/schema.json'), 'utf8')
) as object;
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

function find(items: CollectionItem[], name: string): CollectionItem | undefined {
  for (const it of items) {
    if (it.name === name) return it;
    const nested = it.items ? find(it.items, name) : undefined;
    if (nested) return nested;
  }
  return undefined;
}
const http = (items: CollectionItem[], name: string) => find(items, name)?.request as HttpRequest;
const constructs = (ws: ReadonlyArray<{ kind: string; construct?: string }>) =>
  ws.map((w) => w.construct ?? w.kind);

const v3 = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  $kind: 'collection',
  name: 'C',
  items,
  ...extra,
});

describe('Postman v3 container reader', () => {
  it('reads a migrated YAML folder into the logical tree, ordered by the fractional index', () => {
    const { tree } = readPostmanV3Container(loadFileMap(join(FIXTURES, 'nested')));
    expect(tree.name).toBe('Nested');
    const names = (tree.items as Array<{ name: string }>).map((i) => i.name);
    expect(names).toEqual(['Outer', 'Top']);
  });

  it('strips a single wrapping directory (webkitdirectory / zip root)', () => {
    const files = loadFileMap(join(FIXTURES, 'nested'), 'Nested/');
    expect(isPostmanV3FileMap(files)).toBe(true);
    const { tree } = readPostmanV3Container(files);
    expect(tree.name).toBe('Nested');
    expect((tree.items as unknown[]).length).toBe(2);
  });

  it('every golden fixture validates against the vendored v3 schema', () => {
    for (const dir of ['kitchen-sink', 'nested']) {
      const { tree } = readPostmanV3Container(loadFileMap(join(FIXTURES, dir)));
      const ok = validate(tree);
      expect(validate.errors ?? [], dir).toEqual([]);
      expect(ok).toBe(true);
    }
    const single = JSON.parse(readFileSync(join(FIXTURES, 'all-kinds.json'), 'utf8'));
    const { tree } = readPostmanV3Container(single);
    validate(tree);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('rejects path traversal and absolute paths', () => {
    for (const bad of ['../evil.request.yaml', 'a/../../b.request.yaml', '/etc/x.request.yaml']) {
      expect(() => readPostmanV3Container({ [bad]: '$kind: http-request\nurl: x\n' })).toThrowError(
        PostmanV3ContainerError
      );
    }
    expect(() =>
      readPostmanV3Container({ 'C:\\x\\y.request.yaml': '$kind: http-request\n' })
    ).toThrowError(/path/i);
  });

  it('enforces file-count, per-file, total-size and depth caps', () => {
    const many = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`r${i}.request.yaml`, '$kind: http-request\n'])
    );
    expect(() => readPostmanV3Container(many, { limits: { maxFiles: 5 } })).toThrowError(
      /too many files/i
    );
    expect(() =>
      readPostmanV3Container(
        { 'a.request.yaml': 'x'.repeat(200) },
        { limits: { maxFileBytes: 100 } }
      )
    ).toThrowError(/too large/i);
    expect(() => readPostmanV3Container(many, { limits: { maxTotalBytes: 50 } })).toThrowError(
      /too large/i
    );
    const deep = `${Array.from({ length: 10 }, (_, i) => `d${i}`).join('/')}/r.request.yaml`;
    expect(() =>
      readPostmanV3Container({ [deep]: '$kind: http-request\n' }, { limits: { maxDepth: 5 } })
    ).toThrowError(/nested/i);
  });

  it('rejects a YAML alias bomb instead of expanding it', () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      '$kind: http-request',
      'url: [*f]',
    ].join('\n');
    expect(() => readPostmanV3Container({ 'r.request.yaml': bomb })).toThrowError(
      PostmanV3ContainerError
    );
  });

  it('YAML is loaded with the safe schema (no custom tags)', () => {
    expect(() =>
      readPostmanV3Container({ 'r.request.yaml': "$kind: http-request\nurl: !!js/function 'x'\n" })
    ).toThrowError();
  });
});

describe('Postman v3 zip archives', () => {
  it('unzips into a file map', () => {
    const zip = zipSync({ 'C/r.request.yaml': strToU8('$kind: http-request\nurl: https://x\n') });
    expect(Object.keys(unzipPostmanV3Archive(zip))).toEqual(['C/r.request.yaml']);
  });

  it('rejects traversal entries', () => {
    const zip = zipSync({ '../escape.request.yaml': strToU8('$kind: http-request\n') });
    expect(() => unzipPostmanV3Archive(zip)).toThrowError(PostmanV3ContainerError);
  });

  it('rejects archives that inflate past the size cap', () => {
    const zip = zipSync({ 'big.request.yaml': strToU8('a'.repeat(10_000)) });
    expect(() => unzipPostmanV3Archive(zip, { maxTotalBytes: 1_000 })).toThrowError(/too large/i);
  });
});

describe('Postman version detection', () => {
  it('detects v3 by $kind / *.request.yaml and v2 by info', () => {
    expect(detectPostmanVersion({ $kind: 'collection', name: 'x' })).toBe('3.0');
    expect(detectPostmanVersion({ 'a.request.yaml': '$kind: http-request' })).toBe('3.0');
    expect(
      detectPostmanVersion({
        info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      })
    ).toBe('2.1');
    expect(detectPostmanVersion({ info: { name: 'x' } })).toBe('2.1');
  });

  it('importPostmanCollection returns detectedVersion', () => {
    expect(importPostmanCollection(v3([])).detectedVersion).toBe('3.0');
    expect(importPostmanCollection({ info: { name: 'x' }, item: [] }).detectedVersion).toBe('2.1');
  });
});

describe('Postman v3 → Restura (golden migrated folder)', () => {
  const transformScript = (s: string) => s.replaceAll('pm.', 'rs.');
  const { collection, report } = importPostmanCollection(
    loadFileMap(join(FIXTURES, 'kitchen-sink')),
    { transformScript }
  );

  it('maps the collection shell, variables, scripts and auth', () => {
    expect(collection.name).toBe('Kitchen Sink');
    expect(collection.description).toBe('Golden v2.1 source');
    expect(collection.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}' } });
    expect(collection.preRequestScript).toBe("rs.variables.set('t', Date.now());");
    expect(collection.testScript).toBe("rs.test('ok', () => rs.response.to.be.ok);");
    expect(collection.variables?.map((v) => [v.key, v.value, v.enabled])).toEqual([
      ['baseUrl', 'https://api.example.com', true],
      ['token', '', true],
      ['off', 'x', false],
    ]);
    expect(report.sourceVersion).toBe('3.0');
    expect(collection.items.map((i) => i.name)).toEqual(['Users', 'Auth zoo', 'Bodies']);
  });

  it('maps folders with auth / scripts and orders requests', () => {
    const users = find(collection.items, 'Users')!;
    expect(users.type).toBe('folder');
    expect(users.auth).toEqual({ type: 'basic', basic: { username: 'u', password: 'p' } });
    expect(users.preRequestScript).toBe("console.log('folder');");
    expect(users.items?.map((i) => i.name)).toEqual(['List users', 'Get user', 'Create user']);
  });

  it('maps an HTTP request: query table, disabled headers, noauth, test script, examples', () => {
    const list = http(collection.items, 'List users');
    expect(list.url).toBe('{{baseUrl}}/users');
    expect(list.params.map((p) => [p.key, p.value])).toEqual([
      ['page', '1'],
      ['limit', '10'],
    ]);
    expect(list.headers.map((h) => [h.key, h.enabled])).toEqual([
      ['Accept', true],
      ['X-Off', false],
    ]);
    expect(list.auth).toEqual({ type: 'none' });
    expect(list.testScript).toBe("rs.test('200', () => rs.response.to.have.status(200));");
    const item = find(collection.items, 'List users')!;
    expect(getPostmanSidecar(item)?.response).toHaveLength(1);
    expect(constructs(report.warnings)).toContain('saved-responses');
  });

  it('inherit auth resolves to the nearest folder auth', () => {
    expect(http(collection.items, 'Create user').auth).toEqual({
      type: 'basic',
      basic: { username: 'u', password: 'p' },
    });
    expect(http(collection.items, 'Create user').body).toEqual({
      type: 'json',
      raw: '{"name":"Ada"}',
    });
  });

  it('auth table: 1:1 types map, hawk / jwt degrade to none with a warning + sidecar', () => {
    expect(http(collection.items, 'OAuth1').auth.type).toBe('oauth1');
    expect(http(collection.items, 'OAuth1').auth.oauth1).toMatchObject({
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 't',
      accessTokenSecret: 'ts',
      signatureMethod: 'HMAC-SHA1',
    });
    expect(http(collection.items, 'OAuth2').auth.oauth2).toMatchObject({
      grantType: 'client_credentials',
      clientId: 'cid',
      tokenUrl: 'https://example.com/token',
    });
    expect(http(collection.items, 'API key').auth.apiKey).toEqual({
      key: 'X-Key',
      value: 'v',
      in: 'header',
    });
    expect(http(collection.items, 'Digest').auth.type).toBe('digest');
    expect(http(collection.items, 'AWS').auth.awsSignature).toMatchObject({ region: 'us-east-1' });
    expect(http(collection.items, 'NTLM').auth.ntlm).toMatchObject({ domain: 'CORP' });
    for (const name of ['Hawk', 'JWT']) {
      expect(http(collection.items, name).auth).toEqual({ type: 'none' });
      expect(getPostmanSidecar(find(collection.items, name)!)?.auth).toBeDefined();
    }
    const unsupported = report.warnings.filter((w) => w.kind === 'unsupported-auth');
    expect(unsupported.map((w) => 'authType' in w && w.authType).sort()).toEqual(['hawk', 'jwt']);
  });

  it('maps bodies and keeps extension methods verbatim', () => {
    expect(http(collection.items, 'Form data').body.formData?.map((f) => [f.key, f.type])).toEqual([
      ['name', 'text'],
      ['avatar', 'file'],
    ]);
    expect(http(collection.items, 'Urlencoded').body.type).toBe('x-www-form-urlencoded');
    expect(http(collection.items, 'File body').body.type).toBe('binary');
    expect(http(collection.items, 'GraphQL body').body).toMatchObject({
      type: 'graphql',
      raw: 'query { me { id } }',
      graphqlVariables: '{"a":1}',
    });
    expect(http(collection.items, 'XML').body.type).toBe('xml');
    expect(http(collection.items, 'Purge').method).toBe('PURGE');
  });

  it('maps settings onto per-request settings; substitutes :name path variables', () => {
    expect(http(collection.items, 'Settings').settings).toEqual({
      verifySsl: false,
      followRedirects: false,
      maxRedirects: 3,
      encodeUrlAutomatically: false,
    });
    expect(http(collection.items, 'Get user').url).toBe('{{baseUrl}}/users/42');
    expect(getPostmanSidecar(find(collection.items, 'Get user')!)).toBeUndefined();
  });
});

describe('Postman v3 → Restura (every non-HTTP $kind)', () => {
  const single = JSON.parse(readFileSync(join(FIXTURES, 'all-kinds.json'), 'utf8'));
  const { collection, report } = importPostmanCollection(single);

  it('secret variables import value-less with a re-enter warning', () => {
    const token = collection.variables?.find((v) => v.key === 'apiToken');
    expect(token).toMatchObject({ value: '', secret: true });
    expect(constructs(report.warnings)).toContain('secret-variable');
  });

  it('collection scripts: http:* map, other protocols go to the sidecar', () => {
    expect(collection.preRequestScript).toBe("rs.variables.set('a', 1);");
    expect(getPostmanSidecar(collection)?.scripts).toHaveLength(1);
    expect(constructs(report.warnings)).toContain('protocol-scripts');
  });

  it('graphql-request → HTTP POST with a graphql body', () => {
    const r = http(collection.items, 'Me query');
    expect(r).toMatchObject({
      type: 'http',
      method: 'POST',
      url: 'https://{{host}}/graphql',
      body: {
        type: 'graphql',
        raw: 'query Me { me { id } }',
        graphqlVariables: '{"x":1}',
        graphqlOperationName: 'Me',
      },
      auth: { type: 'bearer', bearer: { token: '{{apiToken}}' } },
      testScript: "rs.test('ok', () => {});",
    });
  });

  it('grpc-request → GrpcRequest', () => {
    const r = find(collection.items, 'Say hello')?.request as GrpcRequest;
    expect(r).toMatchObject({
      type: 'grpc',
      url: 'grpc.example.com:443',
      service: 'helloworld.Greeter',
      method: 'SayHello',
      message: '{"name":"Ada"}',
      methodType: 'unary',
    });
    expect(r.metadata.map((m) => m.key)).toEqual(['x-trace']);
  });

  it('websocket-request → native WebSocket item (not a placeholder folder) (#1209)', () => {
    const item = find(collection.items, 'Echo socket')!;
    expect(item.type).toBe('request');
    expect(getPostmanSidecar(item)?.item).toBeUndefined();
    const r = item.request as WebSocketRequest;
    expect(r).toMatchObject({
      type: 'websocket',
      url: 'wss://echo.example.com',
      protocols: [],
      headers: [],
      message: { body: 'hello', format: 'text' },
      templates: [{ name: 'hi', body: 'hello', format: 'text' }],
    });
    expect(find(collection.items, 'Echo socket (WebSocket)')).toBeUndefined();
  });

  it('socket.io-request → native Socket.IO item with its subscribed events (#1209)', () => {
    const item = find(collection.items, 'Chat')!;
    expect(item.type).toBe('request');
    const r = item.request as SocketIoRequest;
    expect(r).toMatchObject({
      type: 'socketio',
      url: 'https://chat.example.com',
      namespace: '/',
      path: '/socket.io',
      subscribedEvents: ['message'],
      templates: [],
    });
    expect(find(collection.items, 'Chat (Socket.IO)')).toBeUndefined();
  });

  it('mqtt-request → MQTT preset', () => {
    const r = find(collection.items, 'Sensors')?.request as MqttRequest;
    expect(r.type).toBe('mqtt');
    expect(r.connection).toMatchObject({
      brokerUrl: 'mqtt://broker.example.com:1883',
      clientId: 'restura-1',
      protocolVersion: 5,
      keepalive: 30,
      cleanStart: false,
      autoReconnect: false,
      connectTimeout: 10000,
    });
    expect(r.publish).toMatchObject({ topic: 'sensors/temp', payload: '21', qos: 1, retain: true });
    expect(r.subscribe).toEqual({ topicFilter: 'sensors/#', qos: 1 });
    expect(r.templates.map((t) => t.name)).toEqual(['Humidity']);
  });

  it('kafka-request producer + consumer → Kafka presets', () => {
    const p = find(collection.items, 'Produce order')?.request as KafkaRequest;
    expect(p.type).toBe('kafka');
    expect(p.connection).toMatchObject({
      bootstrapBrokers: ['kafka-1:9092', 'kafka-2:9092'],
      acks: -1,
      compression: 'gzip',
    });
    expect(p.produce).toMatchObject({
      topic: 'orders',
      key: 'o-1',
      value: '{"id":1}',
      valueEncoding: 'json',
      partition: 2,
    });
    const c = find(collection.items, 'Consume orders')?.request as KafkaRequest;
    expect(c.consume).toMatchObject({ topics: ['orders'], mode: 'earliest' });
  });

  it('mcp-request over sse → McpRequest with the default JSON-RPC method', () => {
    const r = find(collection.items, 'Remote MCP')?.request as McpRequest;
    expect(r).toMatchObject({
      type: 'mcp',
      transport: 'http-sse',
      url: 'https://mcp.example.com/mcp',
      defaultMethod: 'tools/list',
    });
  });

  it('mcp-request over stdio: imported disabled (placeholder), warned by command', () => {
    const item = find(collection.items, 'Local MCP (MCP stdio, disabled)')!;
    expect(item.type).toBe('folder');
    expect(item.request).toBeUndefined();
    const kept = getPostmanSidecar(item)?.item as Record<string, unknown>;
    expect(kept).toMatchObject({
      transport: 'stdio',
      argv: ['npx', '-y', ''],
      env: [{ key: 'DEBUG' }],
    });
    const r = item;
    const warning = report.warnings.find(
      (w) => w.kind === 'unmodelled-construct' && w.construct === 'mcp-stdio'
    );
    expect(warning && 'detail' in warning && warning.detail).toMatch(/npx/);
    // Nothing on the item can pre-approve the launch.
    expect(JSON.stringify(r)).not.toMatch(/approv|consent|trusted/i);
  });

  it('llm-request / data-request → placeholder + report + sidecar', () => {
    for (const name of ['Ask model (LLM request)', 'Rows (Data request)']) {
      const item = find(collection.items, name)!;
      expect(item.type).toBe('folder');
      expect(getPostmanSidecar(item)?.item).toBeDefined();
    }
    // WebSocket / Socket.IO are native items since #1209: only LLM + data remain.
    expect(constructs(report.warnings).filter((c) => c === 'unsupported-item-kind')).toHaveLength(
      2
    );
  });
});

describe('Postman v3 auth / scripts edge cases', () => {
  it('multi-entry auth takes the first set, warns and keeps the rest in the sidecar', () => {
    const { collection, report } = importPostmanCollection(
      v3([], {
        auth: [
          {
            id: '1',
            name: 'a',
            type: 'basic',
            credentials: [
              { key: 'username', value: 'u' },
              { key: 'password', value: 'p' },
            ],
            rules: [{ key: 'url', value: 'https://a' }],
          },
          { id: '2', name: 'b', type: 'bearer', credentials: [{ key: 'token', value: 't' }] },
        ],
      })
    );
    expect(collection.auth).toEqual({ type: 'basic', basic: { username: 'u', password: 'p' } });
    expect(constructs(report.warnings)).toContain('multi-auth');
    // Mapped credentials are never duplicated into the bag (ADR-0007); the
    // other sets keep only their shape.
    expect(getPostmanSidecar(collection)?.auth).toBeUndefined();
    expect(getPostmanSidecar(collection)?.authSets).toEqual([
      {
        id: '1',
        name: 'a',
        type: 'basic',
        rules: [{ key: 'url', value: 'https://a' }],
        credentialKeys: ['username', 'password'],
      },
      { id: '2', name: 'b', type: 'bearer', credentialKeys: ['token'] },
    ]);
  });

  it('asap / edgegrid / sasl degrade to none + warning', () => {
    for (const type of ['asap', 'edgegrid', 'sasl']) {
      const { collection, report } = importPostmanCollection(
        v3([
          {
            $kind: 'http-request',
            name: 'R',
            url: 'https://x',
            auth: { type, credentials: [{ key: 'k', value: 'v' }] },
          },
        ])
      );
      expect((collection.items[0]?.request as HttpRequest).auth).toEqual({ type: 'none' });
      expect(report.warnings.some((w) => w.kind === 'unsupported-auth')).toBe(true);
    }
  });

  it('scripts with packages / cross-request refs are warned', () => {
    const { report } = importPostmanCollection(
      v3([
        {
          $kind: 'http-request',
          name: 'R',
          url: 'https://x',
          scripts: [{ type: 'beforeRequest', code: 'x', packages: { lodash: { id: 'p1' } } }],
        },
      ])
    );
    expect(constructs(report.warnings)).toContain('script-packages');
  });

  it('unresolvable path variables stay literal, are reported and kept', () => {
    const { collection, report } = importPostmanCollection(
      v3([
        {
          $kind: 'http-request',
          name: 'R',
          url: 'https://x/users/:id/:missing#frag',
          pathVariables: [
            { key: 'id', value: '7' },
            { key: 'missing', value: '' },
          ],
        },
      ])
    );
    const item = collection.items[0]!;
    expect((item.request as HttpRequest).url).toBe('https://x/users/7/:missing#frag');
    expect(constructs(report.warnings)).toContain('path-variables');
    expect(getPostmanSidecar(item)?.urlVariable).toHaveLength(2);
  });

  it('CONNECT is downgraded to GET with a warning', () => {
    const { collection, report } = importPostmanCollection(
      v3([{ $kind: 'http-request', name: 'R', url: 'https://x', method: 'CONNECT' }])
    );
    expect((collection.items[0]?.request as HttpRequest).method).toBe('GET');
    expect(report.warnings).toContainEqual({
      kind: 'unsupported-method',
      method: 'CONNECT',
      requestName: 'R',
    });
  });
});
