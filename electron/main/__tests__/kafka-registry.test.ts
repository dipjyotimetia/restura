// @vitest-environment node
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExternalResolve = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
vi.mock('../security/encrypted-key', () => ({
  getOrCreateEncryptedKey: vi.fn(() => 'test-encryption-key'),
  getKeyStoreStatus: vi.fn(() => ({ mode: 'safeStorage', plaintextStores: [] })),
}));
vi.mock('../security/external-secret-providers', () => ({
  desktopExternalSecretResolver: { resolve: mockExternalResolve },
}));

import {
  type AddressResolver,
  assertCredentialsTransportAllowed,
  buildRegistryAgentOptions,
  capResponseBytes,
  coerceAvroPayload,
  createGuardedLookup,
  createKafkaRegistryClient,
  KAFKA_SECRET_SCOPE,
  type KafkaRegistryClient,
  RegistryHttpError,
  registryAuthorization,
  resolveFieldSchemaId,
  resolveRegistryAddresses,
  SCHEMA_LABEL_RETRY_MS,
} from '../handlers/kafka/registry';
import { decodeDisplayField } from '../handlers/kafka-serde';
import { setExecutionPolicy } from '../security/execution-policy';
import { __setSecretStoreForTests, storeSecretHandle } from '../security/secret-handle-store';

const memory = new Map<string, unknown>();
const fakeSecretStore = {
  get: (key: string) => memory.get(key) as never,
  set: (key: string, value: unknown) => void memory.set(key, value),
  delete: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  has: (key: string) => memory.has(key),
  get store() {
    return Object.fromEntries(memory.entries()) as never;
  },
};

const noProxy = { enabled: false, type: 'http' as const, host: '', port: 8080, bypassList: [] };
function usePolicy(overrides: Record<string, unknown> = {}): void {
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: noProxy,
    timeout: 5_000,
    tls: { verifySsl: true, serverCipherOrder: false },
    certificates: { clientCertificates: [], caCertificates: [] },
    ...overrides,
  });
}
const localPolicy = { allowLocalhost: true, allowPrivateIPs: false };
/** Fake DNS: every hostname resolves to the given addresses (counts calls). */
function fakeDns(...addresses: string[]): AddressResolver & { calls: string[] } {
  const calls: string[] = [];
  const resolve = (async (hostname: string) => {
    calls.push(hostname);
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }) as AddressResolver & { calls: string[] };
  resolve.calls = calls;
  return resolve;
}

const BYTES_FIXED_SCHEMA = JSON.stringify({
  type: 'record',
  name: 'Blob',
  fields: [
    { name: 'b', type: 'bytes' },
    { name: 'f', type: { type: 'fixed', name: 'Four', size: 4 } },
    { name: 'maybe', type: ['null', 'bytes'] },
    { name: 'list', type: { type: 'array', items: 'bytes' } },
    { name: 'byKey', type: { type: 'map', values: 'bytes' } },
    { name: 'id', type: { type: 'string', logicalType: 'uuid' } },
  ],
});
let flakyLabelCalls = 0;

const AVRO_SCHEMA = JSON.stringify({
  type: 'record',
  name: 'Order',
  fields: [
    { name: 'id', type: 'int' },
    { name: 'sku', type: 'string' },
  ],
});

// Minimal Confluent Schema Registry REST fake.
interface Seen {
  method: string;
  url: string;
  authorization?: string;
}
const seen: Seen[] = [];
const server = http.createServer((req, res) => {
  seen.push({
    method: req.method ?? '',
    url: req.url ?? '',
    ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
  });
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/vnd.schemaregistry.v1+json' });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? '';
  if (url === '/subjects') return send(200, ['orders-value', 'audit-value', 'orders-key']);
  if (url === '/subjects/orders-value/versions') return send(200, [2, 1]);
  if (
    url === '/subjects/orders-value/versions/latest' ||
    url === '/subjects/orders-value/versions/2'
  )
    return send(200, { subject: 'orders-value', version: 2, id: 1, schema: AVRO_SCHEMA });
  if (url === '/subjects/orders-value/versions/1')
    return send(200, { subject: 'orders-value', version: 1, id: 9, schema: AVRO_SCHEMA });
  if (url === '/subjects/a%2Fb/versions/1')
    return send(200, {
      subject: 'a/b',
      version: 1,
      id: 3,
      schemaType: 'JSON',
      schema: '{"type":"object"}',
      references: [{ name: 'x', subject: 'y', version: 1 }, { bogus: true }],
    });
  if (url === '/schemas/ids/1') return send(200, { schema: AVRO_SCHEMA });
  if (url === '/schemas/ids/1/versions')
    return send(200, [{ subject: 'orders-value', version: 2 }]);
  if (url === '/schemas/ids/5/versions') return send(404, { error_code: 40403, message: 'nope' });
  if (url === '/schemas/ids/21') return send(200, { schema: BYTES_FIXED_SCHEMA });
  if (url === '/schemas/ids/6/versions') {
    flakyLabelCalls += 1;
    return flakyLabelCalls === 1
      ? send(503, { message: 'busy' })
      : send(200, [{ subject: 'flaky-value', version: 1 }]);
  }
  if (url === '/schemas/ids/77') return send(200, { schema: 'x'.repeat(9 * 1024 * 1024) });
  if (url === '/small') return send(200, { ok: true });
  if (url === '/big') return send(200, { pad: 'y'.repeat(4096) });
  if (url === '/broken') return send(200, 'not-an-array');
  return send(404, { error_code: 40401, message: `Subject not found.` });
});
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const clients: KafkaRegistryClient[] = [];
async function client(
  auth?: Parameters<typeof createKafkaRegistryClient>[0]['auth'],
  url = base
): Promise<KafkaRegistryClient> {
  const created = await createKafkaRegistryClient({ url, ...(auth ? { auth } : {}) }, localPolicy);
  clients.push(created);
  return created;
}

beforeEach(() => {
  seen.length = 0;
  memory.clear();
  __setSecretStoreForTests(fakeSecretStore);
  mockExternalResolve.mockReset();
  usePolicy();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

describe('buildRegistryAgentOptions', () => {
  it('carries the host-selected CA, mTLS material and verify toggle into the agent', () => {
    usePolicy({
      tls: { verifySsl: false, serverCipherOrder: false, minTlsVersion: 'TLSv1.3' },
      certificates: {
        clientCertificates: [
          {
            id: 'c',
            host: 'registry.example.test',
            cert: { format: 'pem', cert: 'CLIENT-CERT', key: 'CLIENT-KEY' },
          },
        ],
        caCertificates: [{ id: 'ca', host: 'registry.example.test', pem: 'PRIVATE-CA' }],
      },
    });
    const options = buildRegistryAgentOptions('https://registry.example.test:8081', localPolicy);
    expect(options).toMatchObject({
      keepAlive: true,
      timeout: 5_000,
      ca: 'PRIVATE-CA',
      cert: 'CLIENT-CERT',
      key: 'CLIENT-KEY',
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    });
    expect(typeof options.lookup).toBe('function');
  });

  it('verifies certificates by default and adds no TLS material for plain HTTP', () => {
    expect(buildRegistryAgentOptions('https://r.example.test', localPolicy)).toMatchObject({
      rejectUnauthorized: true,
    });
    const plain = buildRegistryAgentOptions('http://r.example.test', localPolicy);
    expect(plain).not.toHaveProperty('rejectUnauthorized');
    expect(plain).not.toHaveProperty('ca');
  });

  it('fails closed when a proxy is active for the registry host', () => {
    usePolicy({ proxy: { ...noProxy, enabled: true, host: 'proxy.test', port: 3128 } });
    expect(() => buildRegistryAgentOptions('https://r.example.test', localPolicy)).toThrow(
      /cannot honor the configured HTTP proxy/
    );
  });
});

describe('registryAuthorization', () => {
  it('keeps HTTP Basic (legacy behaviour) and skips it without a username', async () => {
    expect(await registryAuthorization({ type: 'basic', username: 'u', password: 'p' })).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`
    );
    expect(await registryAuthorization({ type: 'basic', username: 'u' })).toBe(
      `Basic ${Buffer.from('u:').toString('base64')}`
    );
    expect(await registryAuthorization({ type: 'basic', password: 'p' })).toBeUndefined();
    expect(await registryAuthorization(undefined)).toBeUndefined();
  });

  it('builds a bearer header from plaintext, inline and keychain-handle tokens', async () => {
    expect(await registryAuthorization({ type: 'bearer', token: 'plain' })).toBe('Bearer plain');
    expect(
      await registryAuthorization({ type: 'bearer', token: { kind: 'inline', value: 'inl' } })
    ).toBe('Bearer inl');
    const { id } = storeSecretHandle({ value: 'from-keychain', scope: KAFKA_SECRET_SCOPE });
    expect(await registryAuthorization({ type: 'bearer', token: { kind: 'handle', id } })).toBe(
      'Bearer from-keychain'
    );
  });

  it('refuses keychain handles that are not scoped for Kafka', async () => {
    const other = storeSecretHandle({ value: 'http-secret', scope: 'http' });
    const unscoped = storeSecretHandle({ value: 'legacy-secret' });
    for (const { id } of [other, unscoped]) {
      const attempt = registryAuthorization({ type: 'bearer', token: { kind: 'handle', id } });
      await expect(attempt).rejects.toThrow(
        'Schema Registry bearer token handle is not scoped for Kafka.'
      );
      await expect(attempt).rejects.not.toThrow(/secret/);
    }
  });

  it('resolves external secret references in main', async () => {
    mockExternalResolve.mockResolvedValue('vault-token');
    const token = {
      kind: 'external' as const,
      provider: 'aws-secrets-manager' as const,
      profileId: 'p',
      secretId: 's',
    };
    expect(await registryAuthorization({ type: 'bearer', token })).toBe('Bearer vault-token');
    expect(mockExternalResolve).toHaveBeenCalledWith(token);
  });

  it('rejects unresolvable handles and header-injection attempts', async () => {
    await expect(
      registryAuthorization({
        type: 'bearer',
        token: { kind: 'handle', id: '00000000-0000-4000-8000-000000000000' },
      })
    ).rejects.toThrow(/not scoped for Kafka/);
    await expect(
      registryAuthorization({ type: 'bearer', token: { kind: 'inline', value: '' } })
    ).rejects.toThrow(/could not be resolved/);
    await expect(
      registryAuthorization({ type: 'bearer', token: 'a\r\nX-Evil: 1' })
    ).rejects.toThrow(/invalid characters/);
  });
});

describe('createGuardedLookup', () => {
  const lookup = (host: string, policy = localPolicy, all = false) =>
    new Promise<{ err: Error | null; address: unknown }>((resolve) => {
      createGuardedLookup('localhost', policy)(
        host,
        { all },
        (err: Error | null, address: unknown) => resolve({ err, address })
      );
    });

  it('resolves the registry host through the DNS guard', async () => {
    const single = await lookup('localhost');
    expect(single.err).toBeNull();
    expect(typeof single.address).toBe('string');
    const all = await lookup('localhost', localPolicy, true);
    expect(Array.isArray(all.address)).toBe(true);
  });

  it('refuses any other hostname (redirect / pivot escape)', async () => {
    expect((await lookup('evil.example.test')).err?.message).toMatch(/refused unexpected host/);
  });

  it('applies the allowLocalhost policy to resolved addresses', async () => {
    const result = await lookup('localhost', { allowLocalhost: false, allowPrivateIPs: false });
    expect(result.err).toBeInstanceOf(Error);
  });

  const viaFakeDns = (resolve: AddressResolver, policy = defaultPolicy, all = false) =>
    new Promise<{ err: Error | null; address: unknown }>((done) => {
      createGuardedLookup('schema-registry', policy, resolve)(
        'schema-registry',
        { all },
        (err: Error | null, address: unknown) => done({ err, address })
      );
    });
  const defaultPolicy = { allowLocalhost: true, allowPrivateIPs: false };

  it('allows private answers under the default policy, like brokers', async () => {
    expect(await viaFakeDns(fakeDns('10.0.0.5'))).toEqual({ err: null, address: '10.0.0.5' });
    expect(
      (await viaFakeDns(fakeDns('172.18.0.4', '10.0.0.6'), defaultPolicy, true)).address
    ).toEqual([
      { address: '172.18.0.4', family: 4 },
      { address: '10.0.0.6', family: 4 },
    ]);
  });

  it.each(['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe'])(
    'always refuses the cloud-metadata answer %s',
    async (address) => {
      const result = await viaFakeDns(fakeDns('10.0.0.5', address), {
        allowLocalhost: true,
        allowPrivateIPs: true,
      });
      expect(result.err?.message).toMatch(/metadata/);
    }
  );

  it('refuses loopback answers only when localhost is disabled', async () => {
    expect((await viaFakeDns(fakeDns('127.0.0.1'))).err).toBeNull();
    const blocked = await viaFakeDns(fakeDns('127.0.0.1'), {
      allowLocalhost: false,
      allowPrivateIPs: true,
    });
    expect(blocked.err?.message).toMatch(/loopback/);
  });

  it('reports DNS failures and empty answers', async () => {
    const failing: AddressResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(resolveRegistryAddresses('x', defaultPolicy, failing)).rejects.toThrow(
      'DNS lookup failed for x: ENOTFOUND'
    );
    await expect(resolveRegistryAddresses('x', defaultPolicy, fakeDns())).rejects.toThrow(
      'DNS returned no records for x'
    );
    const nonError: AddressResolver = async () => {
      throw 'boom';
    };
    expect((await viaFakeDns(nonError)).err?.message).toMatch(/boom/);
  });

  it('ignores calls without a callback', () => {
    expect(() => createGuardedLookup('localhost', localPolicy)('localhost', {})).not.toThrow();
  });
});

describe('createKafkaRegistryClient', () => {
  it('rejects registries the SSRF policy forbids before any request', async () => {
    await expect(
      createKafkaRegistryClient({ url: base }, { allowLocalhost: false, allowPrivateIPs: false })
    ).rejects.toThrow();
    await expect(
      createKafkaRegistryClient({ url: 'http://169.254.169.254/' }, localPolicy)
    ).rejects.toThrow(/metadata/i);
    expect(seen).toHaveLength(0);
  });

  it('dials library and browse sockets through the guarded lookup (real sockets)', async () => {
    // `registry.corp.test` only exists in the fake resolver, so these requests
    // can succeed only if every socket resolves through the guarded lookup.
    const port = (server.address() as AddressInfo).port;
    const url = `http://registry.corp.test:${port}`;
    const viaLibrary = await createKafkaRegistryClient({ url }, localPolicy, {
      resolve: fakeDns('127.0.0.1'),
    });
    clients.push(viaLibrary);
    await viaLibrary.resolveSchemaId({ subject: 'orders-value', version: 'latest' });

    const dnsForBrowse = fakeDns('127.0.0.1');
    const viaBrowse = await createKafkaRegistryClient({ url }, localPolicy, {
      resolve: dnsForBrowse,
    });
    clients.push(viaBrowse);
    expect(dnsForBrowse.calls).toEqual(['registry.corp.test']); // pre-flight
    await viaBrowse.listSubjects();
    expect(dnsForBrowse.calls).toEqual(['registry.corp.test', 'registry.corp.test']);
  });

  it('applies the broker-aligned DNS posture at pre-flight', async () => {
    const make = (resolve: AddressResolver, policy = localPolicy) =>
      createKafkaRegistryClient({ url: 'https://schema-registry:8081' }, policy, { resolve }).then(
        (c) => {
          clients.push(c);
          return c;
        }
      );
    await expect(make(fakeDns('10.1.2.3'))).resolves.toBeDefined();
    await expect(make(fakeDns('169.254.169.254'))).rejects.toThrow(/metadata/);
    await expect(
      make(fakeDns('127.0.0.1'), { allowLocalhost: false, allowPrivateIPs: false })
    ).rejects.toThrow(/loopback/);
    // Literal private IPs keep the string-level network policy (same as brokers).
    await expect(
      createKafkaRegistryClient({ url: 'https://10.1.2.3:8081' }, localPolicy)
    ).rejects.toThrow(/Schema Registry URL rejected/);
  });

  it('re-enforces the plain-HTTP credential rule on every new socket', async () => {
    const port = (server.address() as AddressInfo).port;
    let answer = '127.0.0.1';
    const dns: AddressResolver = async () => [{ address: answer, family: 4 }];
    const registry = await createKafkaRegistryClient(
      { url: `http://registry.corp.test:${port}`, auth: { type: 'bearer', token: 't' } },
      localPolicy,
      { resolve: dns }
    );
    clients.push(registry);
    expect(await registry.listSubjects()).toHaveLength(3);

    // The name later moves to a public address (DNS change / VPN drop / rebind).
    answer = '93.184.216.34';
    registry.close(); // force a fresh socket
    seen.length = 0;
    await expect(registry.listVersions('orders-value')).rejects.toThrow(
      /credentials require HTTPS: registry.corp.test resolved to public address 93.184.216.34/
    );
    expect(seen).toHaveLength(0);
  });

  it('applies the private-answer requirement only when requested', () => {
    const lookup = (requirePrivate: boolean) =>
      new Promise<Error | null>((done) => {
        createGuardedLookup(
          'r.example.com',
          localPolicy,
          fakeDns('93.184.216.34'),
          requirePrivate
        )('r.example.com', {}, (err: Error | null) => done(err));
      });
    return Promise.all([
      expect(lookup(false)).resolves.toBeNull(),
      expect(lookup(true)).resolves.toBeInstanceOf(Error),
    ]);
  });

  it('refuses credentials over plain HTTP to a public registry', async () => {
    await expect(
      createKafkaRegistryClient(
        { url: 'http://registry.example.com', auth: { type: 'bearer', token: 't' } },
        localPolicy,
        { resolve: fakeDns('93.184.216.34') }
      )
    ).rejects.toThrow(/require HTTPS/);
    const internal = await createKafkaRegistryClient(
      { url: 'http://schema-registry:8081', auth: { type: 'basic', username: 'u' } },
      localPolicy,
      { resolve: fakeDns('172.18.0.9') }
    );
    clients.push(internal);
  });

  it('sends the bearer header on library and browse requests', async () => {
    const registry = await client({ type: 'bearer', token: 'tok-1' });
    await registry.resolveSchemaId({ subject: 'orders-value', version: 'latest' });
    await registry.listSubjects();
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-1']);
  });

  it('keeps HTTP Basic on library and browse requests', async () => {
    const registry = await client({ type: 'basic', username: 'u', password: 'p' });
    await registry.resolveSchemaId({ subject: 'orders-value', version: 1 });
    await registry.listVersions('orders-value');
    const basic = `Basic ${Buffer.from('u:p').toString('base64')}`;
    expect(seen.map((s) => s.authorization)).toEqual([basic, basic]);
  });

  it('resolves subject + version (latest or numbered) to a schema id', async () => {
    const registry = await client();
    expect(await registry.resolveSchemaId({ schemaId: 42 })).toBe(42);
    expect(await registry.resolveSchemaId({ subject: 'orders-value', version: 'latest' })).toBe(1);
    expect(await registry.resolveSchemaId({ subject: 'orders-value', version: 1 })).toBe(9);
    // Numbered versions are immutable and cached; latest is always re-resolved.
    await registry.resolveSchemaId({ subject: 'orders-value', version: 1 });
    await registry.resolveSchemaId({ subject: 'orders-value', version: 'latest' });
    expect(seen.filter((s) => s.url.endsWith('/versions/1'))).toHaveLength(1);
    expect(seen.filter((s) => s.url.endsWith('/versions/latest'))).toHaveLength(2);
  });

  it('reports a clear error when the subject does not exist', async () => {
    const registry = await client();
    await expect(
      registry.resolveSchemaId({ subject: 'missing-value', version: 'latest' })
    ).rejects.toThrow(/Schema subject "missing-value" \(version latest\) could not be resolved/);
    expect(await resolveFieldSchemaId(registry, { subject: 'missing-value', version: 3 })).toEqual({
      error: expect.stringMatching(/missing-value.*version 3/),
    });
  });

  it('lists subjects and versions sorted, and parses schema detail', async () => {
    const registry = await client();
    expect(await registry.listSubjects()).toEqual(['audit-value', 'orders-key', 'orders-value']);
    expect(await registry.listVersions('orders-value')).toEqual([1, 2]);
    expect(await registry.getSchema('orders-value', 'latest')).toEqual({
      id: 1,
      subject: 'orders-value',
      version: 2,
      schemaType: 'AVRO',
      schema: AVRO_SCHEMA,
      references: [],
    });
    expect(await registry.getSchema('a/b', 1)).toMatchObject({
      id: 3,
      schemaType: 'JSON',
      references: [{ name: 'x', subject: 'y', version: 1 }],
    });
  });

  it('surfaces registry error messages for browse failures', async () => {
    const registry = await client();
    await expect(registry.listVersions('missing')).rejects.toThrow(
      'Schema Registry responded 404: Subject not found.'
    );
    await expect(registry.getSchema('missing', 'latest')).rejects.toThrow(/404/);
  });

  it('rejects malformed list payloads', async () => {
    const registry = await client(undefined, `${base}/broken#`);
    await expect(registry.listSubjects()).rejects.toThrow(/unexpected subjects list/);
  });

  it('maps schema ids to subject/version with caching and graceful misses', async () => {
    const registry = await client();
    expect(await registry.describeSchemaId(1)).toEqual({
      id: 1,
      subject: 'orders-value',
      version: 2,
    });
    await registry.describeSchemaId(1);
    expect(seen.filter((s) => s.url === '/schemas/ids/1/versions')).toHaveLength(1);
    expect(await registry.describeSchemaId(5)).toEqual({ id: 5 });
    // getSchema seeds the cache, so no lookup request is needed afterwards.
    await registry.getSchema('a/b', 1);
    seen.length = 0;
    expect(await registry.describeSchemaId(3)).toEqual({ id: 3, subject: 'a/b', version: 1 });
    expect(seen).toHaveLength(0);
  });

  it('caches transient label failures for a cooldown, then retries', async () => {
    flakyLabelCalls = 0;
    const registry = await client();
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      expect(await registry.describeSchemaId(6)).toEqual({ id: 6 });
      // Within the cooldown: no new request, so consumption never re-waits.
      expect(await registry.describeSchemaId(6)).toEqual({ id: 6 });
      expect(flakyLabelCalls).toBe(1);

      now.mockReturnValue(1_000_000 + SCHEMA_LABEL_RETRY_MS);
      expect(await registry.describeSchemaId(6)).toEqual({
        id: 6,
        subject: 'flaky-value',
        version: 1,
      });
      expect(flakyLabelCalls).toBe(2);
      await registry.describeSchemaId(6);
      expect(flakyLabelCalls).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('encodes generated Avro examples with bytes and fixed fields', async () => {
    const registry = await client();
    // Exactly what the renderer's "Generate example" produces for this schema.
    const generated = {
      b: '',
      f: '\u0000\u0000\u0000\u0000',
      maybe: '',
      list: [''],
      byKey: { key: '' },
      id: '',
    };
    const encoded = await registry.encode(21, JSON.parse(JSON.stringify(generated)));
    const decoded = (await registry.decode(encoded)) as Record<string, unknown>;
    expect(Buffer.isBuffer(decoded.b)).toBe(true);
    expect(decoded.f).toEqual(Buffer.alloc(4));
    expect(decoded.list).toEqual([Buffer.alloc(0)]);
    const custom = await registry.encode(21, { ...generated, b: 'h\u00ff', maybe: null });
    expect(((await registry.decode(custom)) as { b: Buffer }).b).toEqual(Buffer.from([0x68, 0xff]));
  });

  it('round-trips an Avro record and labels decoded fields with subject/version', async () => {
    const registry = await client();
    const id = await registry.resolveSchemaId({ subject: 'orders-value', version: 'latest' });
    const encoded = await registry.encode(id, { id: 7, sku: 'A-1' });
    expect(encoded[0]).toBe(0);
    expect(await decodeDisplayField(registry, encoded)).toEqual({
      value: '{"id":7,"sku":"A-1"}',
      encoding: 'utf8',
      schema: { id: 1, subject: 'orders-value', version: 2 },
    });
  });

  it('bounds library-path responses so a hostile registry cannot exhaust memory', async () => {
    const registry = await client();
    await expect(registry.decode(Buffer.from([0, 0, 0, 0, 77, 1]))).rejects.toThrow();
  });
});

describe('capResponseBytes', () => {
  const get = (agent: http.Agent, path: string) =>
    new Promise<number>((resolve, reject) => {
      http
        .get(`${base}${path}`, { agent }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
          res.on('error', reject);
        })
        .on('error', reject);
    });

  it('destroys a socket whose response exceeds the cap and resets on reuse', async () => {
    const agent = capResponseBytes(new http.Agent({ keepAlive: true, maxSockets: 1 }), 1024);
    try {
      expect(await get(agent, '/small')).toBe(200);
      expect(await get(agent, '/small')).toBe(200); // reused socket starts from zero
      await expect(get(agent, '/big')).rejects.toThrow(/size limit/);
    } finally {
      agent.destroy();
    }
  });

  it('leaves non-Avro payloads and non-string values untouched', () => {
    const payload = { a: 1 };
    expect(coerceAvroPayload({ type: 'object' }, payload)).toBe(payload);
    expect(coerceAvroPayload(undefined, 'x')).toBe('x');
  });
});

describe('assertCredentialsTransportAllowed', () => {
  const check =
    (url: string, creds: boolean, resolved: string[] = []) =>
    () =>
      assertCredentialsTransportAllowed(new URL(url), creds, resolved);

  it('allows HTTPS, credential-less HTTP, loopback and private-network HTTP', () => {
    expect(check('https://registry.example.com', true)).not.toThrow();
    expect(check('http://registry.example.com', false)).not.toThrow();
    expect(check('http://localhost:8081', true)).not.toThrow();
    expect(check('http://reg.localhost:8081', true)).not.toThrow();
    expect(check('http://127.0.0.1:8081', true, ['127.0.0.1'])).not.toThrow();
    expect(check('http://[::1]:8081', true, ['::1'])).not.toThrow();
    expect(check('http://10.0.0.4:8081', true, ['10.0.0.4'])).not.toThrow();
    expect(check('http://schema-registry:8081', true, ['172.18.0.2'])).not.toThrow();
  });

  it('refuses credentials over HTTP to public or mixed answers', () => {
    expect(check('http://registry.example.com', true, ['93.184.216.34'])).toThrow(/require HTTPS/);
    expect(check('http://registry.example.com', true, ['10.0.0.1', '93.184.216.34'])).toThrow(
      /require HTTPS/
    );
    expect(check('http://registry.example.com', true)).toThrow(/require HTTPS/);
  });

  it('keeps the HTTP status on registry errors', () => {
    expect(new RegistryHttpError(404, 'x').status).toBe(404);
  });
});

describe('decodeDisplayField schema labels', () => {
  const framed = Buffer.from([0, 0, 0, 0, 9, 1]);

  it('never stalls the consume path on a slow label lookup', async () => {
    const started = Date.now();
    const slow = {
      decode: async () => ({ ok: true }),
      describeSchemaId: () => new Promise<never>(() => {}),
    };
    expect(await decodeDisplayField(slow, framed, 20)).toEqual({
      value: '{"ok":true}',
      encoding: 'utf8',
      schema: { id: 9 },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('falls back to the bare id when the label lookup fails or is unsupported', async () => {
    const failing = {
      decode: async () => 'v',
      describeSchemaId: async () => {
        throw new Error('down');
      },
    };
    expect((await decodeDisplayField(failing, framed)).schema).toEqual({ id: 9 });
    expect((await decodeDisplayField({ decode: async () => 'v' }, framed)).schema).toEqual({
      id: 9,
    });
  });
});
