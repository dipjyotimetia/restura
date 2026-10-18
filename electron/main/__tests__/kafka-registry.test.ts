// @vitest-environment node
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExternalResolve = vi.hoisted(() => vi.fn());
const dnsGuardCalls = vi.hoisted(() => ({ hosts: [] as string[] }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
vi.mock('../security/encrypted-key', () => ({
  getOrCreateEncryptedKey: vi.fn(() => 'test-encryption-key'),
  getKeyStoreStatus: vi.fn(() => ({ mode: 'safeStorage', plaintextStores: [] })),
}));
// Pass-through spy: proves both the library (mappersmith) and browse request
// paths dial through the guarded agent lookup, not the system resolver.
vi.mock('../security/dns-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security/dns-guard')>();
  return {
    ...actual,
    assertHostnameSafe: (
      hostname: string,
      options: Parameters<typeof actual.assertHostnameSafe>[1]
    ) => {
      dnsGuardCalls.hosts.push(hostname);
      return actual.assertHostnameSafe(hostname, options);
    },
  };
});
vi.mock('../security/external-secret-providers', () => ({
  desktopExternalSecretResolver: { resolve: mockExternalResolve },
}));

import {
  buildRegistryAgentOptions,
  capResponseBytes,
  createGuardedLookup,
  createKafkaRegistryClient,
  type KafkaRegistryClient,
  registryAuthorization,
  resolveFieldSchemaId,
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
    const { id } = storeSecretHandle({ value: 'from-keychain' });
    expect(await registryAuthorization({ type: 'bearer', token: { kind: 'handle', id } })).toBe(
      'Bearer from-keychain'
    );
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

  it('resolves the registry host through the DNS guard for library and browse sockets', async () => {
    dnsGuardCalls.hosts.length = 0;
    const viaLibrary = await client();
    expect(dnsGuardCalls.hosts).toEqual(['localhost']); // pre-flight
    await viaLibrary.resolveSchemaId({ subject: 'orders-value', version: 'latest' });
    expect(dnsGuardCalls.hosts).toEqual(['localhost', 'localhost']);

    dnsGuardCalls.hosts.length = 0;
    const viaBrowse = await client();
    await viaBrowse.listSubjects();
    expect(dnsGuardCalls.hosts).toEqual(['localhost', 'localhost']);
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
});
