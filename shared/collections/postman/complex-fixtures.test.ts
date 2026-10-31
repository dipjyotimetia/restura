import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { redactCollectionSecrets } from '../../secrets/collection-redaction';
import type {
  Collection,
  CollectionItem,
  GrpcRequest,
  HttpRequest,
  KafkaRequest,
  McpRequest,
  MqttRequest,
  SocketIoRequest,
  WebSocketRequest,
} from '../../types';
import { safeFileName } from './export-v3-files';
import {
  exportPostmanV3,
  exportPostmanV21,
  getPostmanSidecar,
  importPostmanCollection,
  importPostmanV3Files,
  readPostmanV3Container,
} from './index';

/**
 * End-to-end coverage over three realistic, deliberately complex collections
 * (`__fixtures__/v21/complex.postman_collection.json`,
 * `__fixtures__/v21/legacy-v20.postman_collection.json`,
 * `__fixtures__/v3/complex/`): every v3 item kind (HTTP, GraphQL, gRPC,
 * WebSocket, Socket.IO, MQTT, Kafka, MCP, LLM), nested folder auth and
 * scripts, every body mode and auth type, settings, examples, secrets and
 * known-lossy constructs. Each is imported, its mapping and full import
 * report pinned, then exported to v2.1 and v3 (schema-validated) and
 * re-imported: the typed model must survive, and every loss must be reported.
 */

const FIXTURES = resolve(process.cwd(), 'shared/collections/postman/__fixtures__');

function loadJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'));
}

function loadFileMap(rel: string): Record<string, string> {
  const dir = join(FIXTURES, rel);
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

const v21Schema = new Ajv({ strict: false, allErrors: true }).compile(
  JSON.parse(readFileSync(resolve(process.cwd(), 'vendor/postman/v2.1.0/schema.json'), 'utf8'))
);
const v3SchemaJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v3.0.0/schema.json'), 'utf8')
) as object;
const v3Ajv = new Ajv({ strict: false, allErrors: true });
v3Ajv.addSchema(v3SchemaJson, 'v3');
const v3Schema = v3Ajv.getSchema('v3')!;

function expectValidV21(doc: unknown) {
  const ok = v21Schema(doc);
  expect(ok ? [] : v21Schema.errors?.slice(0, 5)).toEqual([]);
}

/** v3 `$kind` → its schema definition, to validate items one by one (readable errors). */
const V3_DEFINITION: Record<string, string> = {
  'http-request': 'v3-http-request',
  'graphql-request': 'v3-graphql-request',
  'grpc-request': 'v3-grpc-request',
  'websocket-request': 'v3-websocket-request',
  'socket.io-request': 'v3-socketio-request',
  'mqtt-request': 'v3-mqtt-request',
  'kafka-request': 'v3-kafka-request',
  'mcp-request': 'v3-mcp-request',
  'llm-request': 'v3-llm-request',
};

function v3ItemErrors(items: unknown, path = ''): unknown[] {
  const out: unknown[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    const item = it as { $kind?: string; name?: string; items?: unknown };
    const def = item.$kind ? V3_DEFINITION[item.$kind] : undefined;
    if (def) {
      const validate = v3Ajv.getSchema(`v3#/definitions/${def}`)!;
      if (!validate(item)) out.push({ at: `${path}/${item.name}`, errors: validate.errors });
    }
    out.push(...v3ItemErrors(item.items, `${path}/${item.name}`));
  }
  return out;
}

function expectValidV3(tree: unknown) {
  expect(v3ItemErrors((tree as { items?: unknown }).items)).toEqual([]);
  const ok = v3Schema(tree);
  expect(ok ? [] : v3Schema.errors?.slice(0, 5)).toEqual([]);
}

function find(items: CollectionItem[], name: string): CollectionItem {
  const walk = (list: CollectionItem[]): CollectionItem | undefined => {
    for (const it of list) {
      if (it.name === name) return it;
      const nested = it.items ? walk(it.items) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };
  const hit = walk(items);
  if (!hit) throw new Error(`no item named ${name}`);
  return hit;
}

function http(c: Collection, name: string): HttpRequest {
  const r = find(c.items, name).request;
  expect(r?.type).toBe('http');
  return r as HttpRequest;
}

/** `construct | owner [| detail]`, sorted — a stable golden for a report. */
function entries(list: ReadonlyArray<object>): string[] {
  return list
    .map((entry) => entry as Record<string, unknown>)
    .map((w) =>
      [w.construct ?? w.kind, w.requestName ?? w.itemName, w.authType ?? w.setting]
        .filter((x) => x !== undefined)
        .join(' | ')
    )
    .sort();
}

/** Drop generated ids, undefined keys and the format-specific `_postman` bag. */
function typed(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(typed);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k, x]) => k !== 'id' && k !== '_postman' && x !== undefined)
      .map(([k, x]) => [k, typed(x)])
  );
}

function v3Files(collection: Collection) {
  const out = exportPostmanV3(collection);
  expectValidV3(out.tree);
  expectValidV3(readPostmanV3Container(out.files).tree);
  // As a zip / picked folder would arrive: under a wrapper directory.
  const wrapped = Object.fromEntries(
    Object.entries(out.files).map(([p, text]) => [`${safeFileName(collection.name)}/${p}`, text])
  );
  return { out, again: importPostmanV3Files(wrapped) };
}

function v21RoundTrip(collection: Collection) {
  const out = exportPostmanV21(collection);
  expectValidV21(out.collection);
  return { out, again: importPostmanCollection(JSON.parse(JSON.stringify(out.collection))) };
}

// ── v2.1 ────────────────────────────────────────────────────────────────────

describe('complex v2.1 collection', () => {
  const source = loadJson('v21/complex.postman_collection.json');
  const imported = importPostmanCollection(source);
  const c = imported.collection;

  it('reports every dropped or approximated construct (and nothing else)', () => {
    expect(imported.detectedVersion).toBe('2.1');
    expect(entries(imported.report.warnings)).toEqual([
      'awsv4-options | AWS STS',
      'explicit-noauth | Legacy login',
      'extra-events | Get user',
      'file-body | Binary',
      'form-file | Avatar upload',
      'item-variables | Users',
      'oauth1-options | OAuth1 RSA',
      'oauth2-grant | OAuth2 PKCE',
      'protocol-profile-behavior | Complex v2.1',
      'protocol-profile-behavior | Get user',
      'saved-responses | Get user',
      'secret-variable | Complex v2.1',
      'security-downgrade | Get user | strictSSL',
      'unsupported-auth | Hawk folder | hawk',
      'unsupported-auth | Hawk | hawk',
      'unsupported-auth | JWT | jwt',
      'unsupported-auth | Under hawk | hawk',
    ]);
  });

  it('maps collection info, variables (disabled, legacy id, secret) and scripts', () => {
    expect(c.name).toBe('Complex v2.1');
    expect(c.description).toMatch(/Every v2.1 construct/);
    expect(c.auth).toEqual({ type: 'bearer', bearer: { token: '{{rootToken}}' } });
    expect(c.variables?.map((v) => [v.key, v.value, v.enabled !== false])).toEqual([
      ['baseUrl', 'https://api.example.com', true],
      ['rootToken', 'root-token', true],
      ['retired', 'x', false],
      ['vaulted', '', true],
      ['legacyId', '3', true],
    ]);
    // A secret variable's value never enters the model.
    expect(JSON.stringify(c)).not.toContain('SECRET-VAR-VALUE');
    expect(c.preRequestScript).toContain("rs.environment.set('collectionPre', stamp)");
    expect(c.testScript).toContain('rs.test(');
    expect(getPostmanSidecar(c)?.protocolProfileBehavior).toEqual({ disableBodyPruning: true });
  });

  it('maps a fully loaded request: url, path variable, query, hash, headers, settings, scripts', () => {
    const r = http(c, 'Get user');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('{{baseUrl}}/users/42#profile');
    expect(r.params.map((p) => [p.key, p.value, p.enabled, p.description])).toEqual([
      ['expand', 'roles', true, 'Embed roles'],
      ['debug', '1', false, undefined],
    ]);
    expect(r.headers.map((h) => [h.key, h.enabled, h.description])).toEqual([
      ['Accept', true, 'JSON only'],
      ['X-Off', false, undefined],
    ]);
    expect(r.description).toBe('Fetch one user by id.');
    expect(r.settings).toEqual({
      followRedirects: false,
      maxRedirects: 3,
      verifySsl: false,
      encodeUrlAutomatically: false,
    });
    // Last enabled same-kind event wins; the disabled test never runs.
    expect(r.preRequestScript).toContain("rs.environment.set('requestPre', stamp)");
    expect(r.testScript).toContain("rs.test('status 200'");
    expect(r.testScript).not.toContain('disabled test');
    const sidecar = getPostmanSidecar(find(c.items, 'Get user'));
    expect(sidecar?.protocolProfileBehavior).toEqual({ disableBodyPruning: true });
    expect(sidecar?.response).toHaveLength(1);
    expect((sidecar?.event as unknown[]).length).toBe(2);
  });

  it('maps every body mode', () => {
    expect(http(c, 'Create user').body).toEqual({
      type: 'json',
      raw: '{\n  "name": "{{name}}"\n}',
    });
    const form = http(c, 'Avatar upload').body;
    expect(form.type).toBe('form-data');
    expect(form.formData?.map((f) => [f.key, f.type, f.enabled, f.contentType ?? null])).toEqual([
      ['meta', 'text', true, 'application/json'],
      ['skip', 'text', false, null],
      ['image', 'file', true, null],
    ]);
    // A local path never becomes file bytes.
    expect(form.formData?.[2]).toMatchObject({ value: '', fileName: 'a.png' });
    const urlenc = http(c, 'Legacy login').body;
    expect(urlenc.type).toBe('x-www-form-urlencoded');
    expect(urlenc.formData?.map((f) => [f.key, f.enabled])).toEqual([
      ['user', true],
      ['password', true],
      ['otp', false],
    ]);
    expect(http(c, 'XML').body).toEqual({ type: 'xml', raw: '<a/>' });
    expect(http(c, 'HTML').body).toEqual({ type: 'text', raw: '<b>x</b>' });
    expect(http(c, 'Plain').body).toEqual({ type: 'text', raw: 'hello' });
    expect(http(c, 'Binary').body).toEqual({ type: 'binary' });
    expect(http(c, 'GraphQL templated').body).toEqual({
      type: 'graphql',
      raw: 'query($id: Int) { u(id: $id) { n } }',
      graphqlVariables: '{"id": {{userId}}}',
    });
    expect(JSON.parse(http(c, 'GraphQL object vars').body.graphqlVariables ?? '')).toEqual({
      a: 1,
    });
    expect(http(c, 'Bare string URL')).toMatchObject({ method: 'GET', url: '{{baseUrl}}/bare' });
    expect(http(c, 'Bare string URL').params.map((p) => [p.key, p.value])).toEqual([['x', '1']]);
    expect(http(c, 'Purge').method).toBe('PURGE');
    expect(http(c, 'Raw header block').headers.map((h) => [h.key, h.value])).toEqual([
      ['X-One', '1'],
      ['X-Two', 'two'],
    ]);
  });

  it('maps every auth type and resolves inheritance through nested folders', () => {
    const auth = (name: string) => http(c, name).auth;
    expect(auth('Health')).toEqual(c.auth);
    expect(find(c.items, 'Users').auth).toEqual({
      type: 'basic',
      basic: { username: 'admin', password: 'admin-pw' },
    });
    expect(auth('Create user').type).toBe('basic');
    // Explicit noauth below a configured folder auth stays none (and is guarded).
    expect(auth('Legacy login')).toEqual({ type: 'none' });
    expect(getPostmanSidecar(find(c.items, 'Legacy login'))?.noauth).toBe(true);
    // Admin's OAuth2 reaches the deepest request, including an explicit `inherit`.
    expect(auth('Audit log').type).toBe('oauth2');
    expect(auth('Deepest')).toEqual(auth('Audit log'));
    expect(auth('Audit log').oauth2).toMatchObject({
      grantType: 'client_credentials',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      clientSecret: 'CLIENT-SECRET',
      scope: 'admin users',
    });
    expect(auth('API key query')).toEqual({
      type: 'api-key',
      apiKey: { key: 'api_key', value: 'K', in: 'query' },
    });
    expect(auth('API key header').apiKey?.in).toBe('header');
    expect(auth('Digest')).toEqual({ type: 'digest', digest: { username: 'd', password: 'dp' } });
    expect(auth('OAuth1').oauth1).toMatchObject({
      consumerKey: 'ck',
      accessToken: 't',
      signatureMethod: 'HMAC-SHA256',
      realm: 'photos',
    });
    expect(auth('OAuth2 password').oauth2).toMatchObject({
      grantType: 'password',
      username: 'u',
      password: 'p',
    });
    expect(auth('OAuth2 PKCE').oauth2).toMatchObject({
      grantType: 'authorization_code',
      authorizationUrl: 'https://a/auth',
      redirectUri: 'https://app/cb',
    });
    expect(auth('AWS STS').awsSignature).toEqual({
      accessKey: 'AKIA',
      secretKey: 'AWS-SECRET',
      region: 'us-east-1',
      service: 's3',
    });
    expect(auth('NTLM').ntlm).toEqual({
      username: 'n',
      password: 'np',
      domain: 'CORP',
      workstation: 'WS1',
    });
    expect(auth('Hawk')).toEqual({ type: 'none' });
    expect(auth('JWT')).toEqual({ type: 'none' });
    // An unsupported folder auth cuts the chain: never the collection bearer.
    expect(auth('Under hawk')).toEqual({ type: 'none' });
  });

  it('v2.1 export is schema-valid, reports its losses, and re-imports to the same model', () => {
    const { out, again } = v21RoundTrip(c);
    expect(entries(out.report.entries)).toEqual([
      'auth-unsupported-for-kind | JWT',
      'restored-events | Get user',
      'restored-file-path | Avatar upload',
      'restored-file-path | Binary',
      'secret-variable | Complex v2.1',
    ]);
    // The only typed differences are the reported ones: the secret variable
    // is written empty (re-imports as plain) and jwt has no v2.1 type.
    const before = typed(c) as Collection;
    const after = typed(again.collection) as Collection;
    expect(after.variables?.[3]).toEqual({ key: 'vaulted', value: '', enabled: true });
    expect(before.variables?.[3]).toMatchObject({ key: 'vaulted', secret: true });
    after.variables![3] = before.variables![3]!;
    expect(after).toEqual(before);
    // Sidecar-restored constructs survive the trip.
    const getUser = (out.collection.item[1] as { item: unknown[] }).item[0] as Record<
      string,
      unknown
    >;
    expect(getUser.protocolProfileBehavior).toMatchObject({
      followRedirects: false,
      strictSSL: false,
      disableBodyPruning: true,
    });
    expect((getUser.request as { description?: unknown }).description).toBe(
      'Fetch one user by id.'
    );
    expect((getUser.response as unknown[]).length).toBe(1);
    const events = getUser.event as Array<{ listen: string; disabled?: boolean }>;
    expect(events.filter((e) => e.disabled)).toHaveLength(1);
    const aws = JSON.stringify(out.collection);
    expect(aws).toContain('STS-SESSION-TOKEN');
    expect(aws).toContain('authorization_code_with_pkce');
  });

  it('v3 export is schema-valid and re-imports to the same typed model', () => {
    const { out, again } = v3Files(c);
    expect(entries(out.report.entries)).toEqual([
      'binary-body | Binary',
      'disabled-script | Get user',
      'form-file | Avatar upload',
      'secret-variable | Complex v2.1',
    ]);
    const before = typed(c) as Collection;
    const after = typed(again.collection) as Collection;
    after.variables![3] = before.variables![3]!;
    expect(after).toEqual(before);
    // Approximated auth is restored from the sidecar in v3 too.
    const text = JSON.stringify(out.tree);
    expect(text).toContain('STS-SESSION-TOKEN');
    expect(text).toContain('authorization_code_with_pkce');
    // The shadowed (not the winning, not the disabled) pre-request survives.
    expect(text).toContain("pm.environment.set('shadow', 'first');");
    expect(text).not.toContain('disabled test must not run');
  });

  it('excluding secrets leaves no credential in either export', () => {
    const redacted = redactCollectionSecrets(c);
    const files = [
      JSON.stringify(exportPostmanV21(redacted).collection),
      JSON.stringify(exportPostmanV3(redacted).tree),
    ];
    for (const text of files) {
      for (const secret of [
        'admin-pw',
        'CLIENT-SECRET',
        'AWS-SECRET',
        'STS-SESSION-TOKEN',
        'HAWK-KEY',
        'FOLDER-HAWK-KEY',
        'JWT-SECRET',
        'RSA-PRIVATE',
        'SECRET-VAR-VALUE',
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe('legacy v2.0 collection (object-map auth)', () => {
  const {
    collection: c,
    report,
    detectedVersion,
  } = importPostmanCollection(loadJson('v21/legacy-v20.postman_collection.json'));

  it('detects v2.0, maps object-map auth and inheritance, with a clean report', () => {
    expect(detectedVersion).toBe('2.0');
    expect(report).toEqual({ sourceVersion: '2.0', warnings: [] });
    expect(c.auth).toEqual({ type: 'basic', basic: { username: 'legacy', password: 'legacy-pw' } });
    expect(http(c, 'Inherits').auth).toEqual({ type: 'bearer', bearer: { token: 'folder-tok' } });
    expect(http(c, 'AWS').auth.awsSignature).toEqual({
      accessKey: 'A',
      secretKey: 'S',
      region: 'r',
      service: 's',
    });
    expect(http(c, 'Top')).toMatchObject({ method: 'POST', body: { type: 'text', raw: 'x' } });
    expect(http(c, 'Top').auth.type).toBe('basic');
  });

  it('exports as schema-valid v2.1 and v3', () => {
    const { again } = v21RoundTrip(c);
    expect(typed(again.collection)).toEqual(typed(c));
    expect(typed(v3Files(c).again.collection)).toEqual(typed(c));
  });
});

// ── v3 ──────────────────────────────────────────────────────────────────────

describe('complex v3 folder (every item kind)', () => {
  const files = loadFileMap('v3/complex');
  const imported = importPostmanV3Files(files);
  const c = imported.collection;
  const req = <T>(name: string) => find(c.items, name).request as T;

  it('the fixture itself is schema-valid v3', () => {
    expectValidV3(readPostmanV3Container(files).tree);
  });

  it('reports every dropped or approximated construct (and nothing else)', () => {
    expect(imported.detectedVersion).toBe('3.0');
    expect(entries(imported.report.warnings)).toEqual([
      'awsv4-options | S3 object',
      'broker-leftovers | Sensors',
      'collection-script-scope | Complex Protocols',
      'connection-leftovers | Chat',
      'connection-leftovers | Ticker socket',
      'explicit-noauth | Public',
      'explicit-noauth | Stream prices',
      'extra-events | List orders',
      'file-body | Raw file',
      'form-file | Upload',
      'mcp-stdio | Local MCP',
      'protocol-scripts | Complex Protocols',
      'request-settings | List orders',
      'request-settings | Say hello',
      'request-settings | Stream prices',
      'saved-responses | List orders',
      'secret-variable | Complex Protocols',
      'security-downgrade | List orders | strictSSL',
      'unsupported-auth | Hawk | hawk',
      'unsupported-auth | Sensors | basic',
      'unsupported-item-kind | Ask model',
    ]);
  });

  it('keeps folder order (fractional index) and maps every kind to its Restura type', () => {
    expect(c.items.map((i) => i.name)).toEqual([
      'Health',
      'REST',
      'GraphQL',
      'gRPC',
      'Realtime',
      'Integrations',
    ]);
    const kinds = (folder: string) =>
      (find(c.items, folder).items ?? []).map((i) => i.request?.type ?? `folder:${i.name}`);
    expect(kinds('REST')).toEqual([...Array<string>(10).fill('http'), 'folder:Admin']);
    expect(kinds('GraphQL')).toEqual(['http', 'http']);
    expect(kinds('gRPC')).toEqual(['grpc', 'grpc']);
    expect(kinds('Realtime')).toEqual(['websocket', 'socketio', 'mqtt']);
    expect(kinds('Integrations')).toEqual([
      'kafka',
      'kafka',
      'mcp',
      'folder:Local MCP (MCP stdio, disabled)',
      'folder:Ask model (LLM request)',
    ]);
  });

  it('maps the collection: variables, secret vault variable, scripts, auth', () => {
    expect(c.name).toBe('Complex Protocols');
    expect(c.variables?.map((v) => [v.key, v.value, v.enabled !== false])).toEqual([
      ['baseUrl', 'https://api.example.com', true],
      ['grpcHost', 'grpc.example.com:443', true],
      ['tenant', 'acme', true],
      ['legacy', 'off', false],
      ['apiToken', '', true],
    ]);
    expect(c.variables?.[4]?.secret).toBe(true);
    expect(c.auth).toEqual({ type: 'bearer', bearer: { token: '{{apiToken}}' } });
    expect(c.preRequestScript).toContain("rs.variables.set('stamp'");
    // grpc:beforeInvoke has no collection phase in Restura: kept, reported.
    expect(getPostmanSidecar(c)?.scripts).toHaveLength(1);
  });

  it('maps HTTP: path variables, query, settings, examples, scripts, descriptions', () => {
    const r = req<HttpRequest>('List orders');
    expect(r.url).toBe('{{baseUrl}}/tenants/{{tenant}}/orders#top');
    expect(r.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['page', '1', true],
      ['status', 'open', true],
      ['debug', 'true', false],
    ]);
    expect(r.headers.map((h) => [h.key, h.enabled])).toEqual([
      ['Accept', true],
      ['X-Trace', true],
      ['X-Off', false],
    ]);
    expect(r.settings).toEqual({
      followRedirects: false,
      maxRedirects: 2,
      verifySsl: false,
      disableCookieJar: true,
      httpVersion: 'http2',
    });
    expect(r.description).toMatch(/Lists orders/);
    expect(r.preRequestScript).toContain("rs.variables.set('order', 'second')");
    const sidecar = getPostmanSidecar(find(c.items, 'List orders'));
    expect(sidecar?.settings).toEqual({ maxResponseSize: 1000000 });
    expect(sidecar?.response).toHaveLength(2);
    expect(sidecar?.event).toEqual([
      { type: 'beforeRequest', code: "pm.variables.set('order', 'first');" },
    ]);
    expect(find(c.items, 'REST').auth).toEqual({
      type: 'api-key',
      apiKey: { key: 'X-Api-Key', value: 'folder-key', in: 'header' },
    });
    expect(getPostmanSidecar(find(c.items, 'REST'))?.description).toMatch(/REST endpoints/);
    expect(req<HttpRequest>('Create order').auth.type).toBe('api-key');
    expect(req<HttpRequest>('Upload').body.formData?.[0]).toMatchObject({
      key: 'meta',
      contentType: 'application/json',
      description: 'metadata',
    });
    expect(req<HttpRequest>('Login form').auth.type).toBe('basic');
    expect(req<HttpRequest>('SOAP')).toMatchObject({
      body: { type: 'xml' },
      auth: { type: 'digest' },
    });
    expect(req<HttpRequest>('Raw file').body).toEqual({ type: 'binary' });
    expect(req<HttpRequest>('S3 object').auth.type).toBe('aws-signature');
    expect(req<HttpRequest>('Hawk').auth).toEqual({ type: 'none' });
    expect(req<HttpRequest>('Public').auth).toEqual({ type: 'none' });
    expect(req<HttpRequest>('Purge cache').method).toBe('PURGE');
    // Nested folder OAuth2 reaches the deepest request.
    expect(req<HttpRequest>('Users').auth.type).toBe('oauth2');
    expect(req<HttpRequest>('Events').auth).toEqual(req<HttpRequest>('Users').auth);
    expect(find(c.items, 'Admin').testScript).toContain("rs.test('admin folder test'");
  });

  it('maps GraphQL: native item (operation, templated variables) and body mode', () => {
    expect(req<HttpRequest>('Viewer')).toMatchObject({
      method: 'POST',
      url: '{{baseUrl}}/graphql',
      description: 'Native GraphQL item',
      body: {
        type: 'graphql',
        graphqlVariables: '{"id": {{userId}}}',
        graphqlOperationName: 'Viewer',
      },
      auth: { type: 'bearer', bearer: { token: '{{apiToken}}' } },
    });
    expect(req<HttpRequest>('Body mode').body).toMatchObject({
      type: 'graphql',
      raw: 'mutation { touch }',
    });
  });

  it('maps gRPC: service/method, message, metadata, folder auth, scripts, noauth', () => {
    const g = req<GrpcRequest>('Say hello');
    expect(g).toMatchObject({
      type: 'grpc',
      url: '{{grpcHost}}',
      service: 'helloworld.Greeter',
      method: 'SayHello',
      message: '{\n  "name": "{{user}}"\n}',
      auth: { type: 'bearer', bearer: { token: 'grpc-folder-token' } },
    });
    expect(g.metadata.map((m) => [m.key, m.enabled])).toEqual([
      ['x-tenant', true],
      ['x-off', false],
    ]);
    expect(g.preRequestScript).toContain("rs.request.metadata['x-from-script']");
    expect(g.testScript).toContain("rs.test('grpc ok'");
    const sidecar = getPostmanSidecar(find(c.items, 'Say hello'));
    expect(sidecar?.description).toBe('Unary Greeter call');
    expect(sidecar?.settings).toMatchObject({ strictSSL: false, maxResponseMessageSize: 4194304 });
    expect(req<GrpcRequest>('Stream prices')).toMatchObject({
      service: 'market.Prices',
      method: 'Stream',
      auth: { type: 'none' },
    });
  });

  it('maps WebSocket, Socket.IO and MQTT (incl. MQTT 5 message properties)', () => {
    expect(req<WebSocketRequest>('Ticker socket')).toMatchObject({
      type: 'websocket',
      url: 'wss://stream.example.com/ticker?symbols=ACME,FOO',
      description: 'Live ticker',
      message: { body: '{"op":"sub"}', format: 'json' },
      options: { maxReconnectAttempts: 3, reconnectDelay: 1000 },
    });
    expect(req<WebSocketRequest>('Ticker socket').templates.map((t) => t.name)).toEqual([
      'subscribe',
      'ping',
    ]);
    expect(req<SocketIoRequest>('Chat')).toMatchObject({
      type: 'socketio',
      path: '/socket.io',
      subscribedEvents: ['message', 'typing'],
      emit: { eventName: 'join', ack: true, args: '["room-1", {"nick":"ada"}]' },
    });
    const m = req<MqttRequest>('Sensors');
    expect(m.connection).toMatchObject({
      brokerUrl: 'mqtts://broker.example.com:8883',
      protocolVersion: 5,
      keepalive: 60,
      connectTimeout: 8000,
    });
    expect(m.subscribe).toEqual({ topicFilter: 'sensors/#', qos: 1 });
    expect(m.publish).toMatchObject({
      topic: 'sensors/temp',
      qos: 1,
      retain: true,
      contentType: 'application/json',
      responseTopic: 'sensors/ack',
      userProperties: { unit: 'celsius' },
    });
    // MQTT basic auth is bag-only: its password never reaches the typed model.
    expect(JSON.stringify(m)).not.toContain('MQ-PASS');
  });

  it('maps Kafka, MCP and keeps stdio / LLM as inert placeholders', () => {
    expect(req<KafkaRequest>('Produce order')).toMatchObject({
      type: 'kafka',
      connection: { bootstrapBrokers: ['kafka-1:9092', 'kafka-2:9092'], acks: -1 },
      produce: { topic: 'orders', key: 'o-1', value: '{"id":1}', valueEncoding: 'json' },
    });
    expect(req<KafkaRequest>('Consume orders').consume.topics).toEqual(['orders']);
    expect(req<McpRequest>('Remote MCP')).toMatchObject({
      type: 'mcp',
      transport: 'http-sse',
      url: 'https://mcp.example.com/mcp',
      defaultMethod: 'tools/list',
    });
    const stdio = find(c.items, 'Local MCP (MCP stdio, disabled)');
    expect(stdio.items).toEqual([]);
    // Argument and env values never enter the store.
    expect(JSON.stringify(stdio)).not.toContain('SECRET-ARG');
    expect(JSON.stringify(stdio)).not.toContain('MCP-ENV-SECRET');
    expect(find(c.items, 'Ask model (LLM request)').items).toEqual([]);
  });

  it('v3 export is schema-valid, lossless (empty report) and re-imports identically', () => {
    const { out, again } = v3Files(c);
    expect(out.report.entries).toEqual([]);
    expect(typed(again.collection)).toEqual(typed(c));
    expect(again.report.warnings.map((w) => w.kind).sort()).toEqual(
      imported.report.warnings.map((w) => w.kind).sort()
    );
    const tree = JSON.stringify(out.tree);
    expect(tree).toContain('Unary Greeter call'); // gRPC description restored
    expect(tree).toContain('"responseTopic":"sensors/ack"'); // MQTT properties restored
    expect(tree).toContain('STS-TOKEN'); // AWS session token restored
  });

  it('v2.1 export keeps every HTTP item, reports every non-HTTP item, and re-imports', () => {
    const { out, again } = v21RoundTrip(c);
    expect(entries(out.report.entries)).toEqual([
      'graphql-extras | Viewer',
      'non-http-request | Chat',
      'non-http-request | Consume orders',
      'non-http-request | Produce order',
      'non-http-request | Remote MCP',
      'non-http-request | Say hello',
      'non-http-request | Sensors',
      'non-http-request | Stream prices',
      'non-http-request | Ticker socket',
      'placeholder-item | Ask model (LLM request)',
      'placeholder-item | Local MCP (MCP stdio, disabled)',
      'restored-events | List orders',
      'restored-file-path | Raw file',
      'restored-file-path | Upload',
      'secret-variable | Complex Protocols',
    ]);
    // Every HTTP request comes back with the same typed shape (operation
    // names are v3/Restura-only, so GraphQL Viewer is compared without it).
    for (const name of ['List orders', 'Create order', 'Upload', 'Login form', 'SOAP', 'Events']) {
      expect(typed(http(again.collection, name))).toEqual(typed(http(c, name)));
    }
    const viewer = http(again.collection, 'Viewer');
    expect(viewer.body.graphqlVariables).toBe('{"id": {{userId}}}');
  });

  it('excluding secrets leaves no credential in either export', () => {
    const redacted = redactCollectionSecrets(c);
    for (const text of [
      JSON.stringify(exportPostmanV3(redacted).files),
      JSON.stringify(exportPostmanV21(redacted).collection),
    ]) {
      for (const secret of [
        'folder-key',
        'CLIENT-SECRET',
        'SECRET',
        'STS-TOKEN',
        'HAWK-KEY',
        'MQ-PASS',
        'grpc-folder-token',
      ]) {
        expect(text).not.toContain(`"${secret}"`);
      }
    }
  });
});
