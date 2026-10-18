// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExternalResolve = vi.hoisted(() => vi.fn(async () => 'from-vault'));
const mockFromIni = vi.hoisted(() =>
  vi.fn(() => async () => ({
    accessKeyId: 'ASIAPROFILEEXAMPLE01',
    secretAccessKey: 'profile-secret',
    sessionToken: 'profile-session',
  }))
);

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../security/external-secret-providers', () => ({
  desktopExternalSecretResolver: { resolve: mockExternalResolve },
}));
vi.mock('@aws-sdk/credential-providers', () => ({ fromIni: mockFromIni }));

import { saslOAuthBearer } from '@platformatic/kafka';
import { consoleSink, setLogSink } from '@shared/runtime/logger';
import { buildKafkaSaslOptions, resolveKafkaSecret } from '../handlers/kafka/sasl';
import { GSSAPI_UNAVAILABLE_MESSAGE } from '../handlers/kafka/sasl-gssapi';
import {
  __setSecretStoreForTests,
  type SecretStoreShape,
  storeSecretHandle,
} from '../security/secret-handle-store';

function memoryStore(): SecretStoreShape {
  const data = new Map<string, unknown>();
  return {
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    get store() {
      return Object.fromEntries(data);
    },
  } as unknown as SecretStoreShape;
}

function decodeMskUrl(token: string): URL {
  return new URL(Buffer.from(token, 'base64url').toString('utf8'));
}

describe('buildKafkaSaslOptions', () => {
  beforeEach(() => {
    __setSecretStoreForTests(memoryStore());
    mockExternalResolve.mockClear();
    mockFromIni.mockClear();
  });

  it('passes PLAIN / SCRAM credentials straight through', () => {
    expect(
      buildKafkaSaslOptions({ mechanism: 'SCRAM-SHA-512', username: 'u', password: 'p' })
    ).toEqual({ mechanism: 'SCRAM-SHA-512', username: 'u', password: 'p' });
  });

  it('keeps legacy static OAUTHBEARER configs (no mode) working', () => {
    expect(
      buildKafkaSaslOptions({ mechanism: 'OAUTHBEARER', token: 't', extensions: { a: 'b' } })
    ).toEqual({ mechanism: 'OAUTHBEARER', token: 't', oauthBearerExtensions: { a: 'b' } });
    expect(buildKafkaSaslOptions({ mechanism: 'OAUTHBEARER', mode: 'static', token: 't' })).toEqual(
      { mechanism: 'OAUTHBEARER', token: 't' }
    );
  });

  it('maps client-credentials to a token provider that resolves the secret handle in main', async () => {
    const { id } = storeSecretHandle({ value: 'client-secret-plain' });
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: 'issued', expires_in: 300 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const opts = buildKafkaSaslOptions(
      {
        mechanism: 'OAUTHBEARER',
        mode: 'client-credentials',
        tokenEndpoint: 'https://idp.example.com/token',
        clientId: 'cid',
        clientSecret: { kind: 'handle', id },
        extensions: { logicalCluster: 'lkc-1' },
      },
      { guardedFetch: async () => fetchImpl as unknown as typeof fetch, now: () => 0 }
    );
    expect(opts.mechanism).toBe('OAUTHBEARER');
    expect(opts.oauthBearerExtensions).toEqual({ logicalCluster: 'lkc-1' });
    expect(typeof opts.token).toBe('function');
    const token = await (opts.token as () => Promise<string>)();
    expect(token).toBe('issued');
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.get('client_secret')).toBe('client-secret-plain');
  });

  it('maps GSSAPI to a custom authenticator that fails honestly without the kerberos addon', async () => {
    const opts = buildKafkaSaslOptions({ mechanism: 'GSSAPI', serviceName: 'kafka' });
    expect(opts.mechanism).toBe('GSSAPI');
    expect(typeof opts.authenticate).toBe('function');
    const error = await new Promise<Error | null>((resolve) => {
      opts.authenticate!(
        'GSSAPI',
        { host: 'broker' } as never,
        vi.fn() as never,
        undefined,
        undefined,
        undefined,
        ((e: Error | null) => resolve(e)) as never
      );
    });
    expect(error?.message).toBe(GSSAPI_UNAVAILABLE_MESSAGE);
  });

  it('maps AWS_MSK_IAM (static handles) onto OAUTHBEARER with a presigned token', async () => {
    const secret = storeSecretHandle({ value: 'aws-secret' });
    const session = storeSecretHandle({ value: 'aws-session' });
    const opts = buildKafkaSaslOptions(
      {
        mechanism: 'AWS_MSK_IAM',
        region: 'us-west-2',
        credentials: {
          source: 'static',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: { kind: 'handle', id: secret.id },
          sessionToken: { kind: 'handle', id: session.id },
        },
      },
      { now: () => Date.UTC(2026, 0, 1) }
    );
    expect(opts.mechanism).toBe('OAUTHBEARER');
    const url = decodeMskUrl(await (opts.token as () => Promise<string>)());
    expect(url.host).toBe('kafka.us-west-2.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAIOSFODNN7EXAMPLE\/20260101\//);
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('aws-session');
  });

  it('loads AWS_MSK_IAM profile credentials through fromIni', async () => {
    const opts = buildKafkaSaslOptions({
      mechanism: 'AWS_MSK_IAM',
      region: 'eu-central-1',
      credentials: { source: 'profile', profile: 'msk-dev' },
    });
    const url = decodeMskUrl(await (opts.token as () => Promise<string>)());
    expect(mockFromIni).toHaveBeenCalledWith({ profile: 'msk-dev' });
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^ASIAPROFILEEXAMPLE01\//);
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('profile-session');
  });

  it('fails clearly when an MSK IAM secret handle is missing', async () => {
    const records: Array<{ message: string; fields: Record<string, unknown> }> = [];
    setLogSink((record) => records.push(record));
    const opts = buildKafkaSaslOptions({
      mechanism: 'AWS_MSK_IAM',
      region: 'us-east-1',
      credentials: {
        source: 'static',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: { kind: 'handle', id: 'gone' },
      },
    });
    await expect((opts.token as () => Promise<string>)()).rejects.toThrow(
      /secret access key.*could not be resolved/
    );
    // The library hides provider errors behind a generic message — log the reason.
    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'sasl credential provider failed',
        fields: expect.objectContaining({ mechanism: 'AWS_MSK_IAM' }),
      })
    );
    setLogSink(consoleSink);
    const withSession = buildKafkaSaslOptions({
      mechanism: 'AWS_MSK_IAM',
      region: 'us-east-1',
      credentials: {
        source: 'static',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'inline-secret',
        sessionToken: { kind: 'handle', id: 'gone' },
      },
    });
    await expect((withSession.token as () => Promise<string>)()).rejects.toThrow(
      /session token.*could not be resolved/
    );
  });
});

describe('compatibility with the real @platformatic/kafka OAUTHBEARER client', () => {
  it('the library calls our token provider on each (re)authentication and frames its result', async () => {
    let now = 0;
    let issued = 0;
    const opts = buildKafkaSaslOptions(
      {
        mechanism: 'OAUTHBEARER',
        mode: 'client-credentials',
        tokenEndpoint: 'https://idp.example.com/token',
        clientId: 'c',
        clientSecret: 's',
        extensions: { logicalCluster: 'lkc-1' },
      },
      {
        resolveSecret: async () => 's',
        now: () => now,
        guardedFetch: async () =>
          (async () =>
            new Response(JSON.stringify({ access_token: `jwt-${++issued}`, expires_in: 60 }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })) as unknown as typeof fetch,
      }
    );
    const authenticateOnce = () =>
      new Promise<string>((resolve, reject) => {
        const api = ((
          _conn: unknown,
          bytes: Buffer,
          cb: (e: Error | null, r?: unknown) => void
        ) => {
          resolve(bytes.toString());
          cb(null, {
            errorCode: 0,
            errorMessage: null,
            authBytes: Buffer.alloc(0),
            sessionLifetimeMs: 0n,
          });
        }) as never;
        saslOAuthBearer.authenticate(
          api,
          {} as never,
          opts.token!,
          opts.oauthBearerExtensions!,
          (e) => {
            if (e) reject(e);
          }
        );
      });

    expect(await authenticateOnce()).toBe(
      'n,,\x01auth=Bearer jwt-1\x01logicalCluster=lkc-1\x01\x01'
    );
    now = 29_000;
    expect(await authenticateOnce()).toContain('Bearer jwt-1');
    // Re-authentication after exp - 30s presents a freshly fetched token.
    now = 30_000;
    expect(await authenticateOnce()).toContain('Bearer jwt-2');
  });
});

describe('resolveKafkaSecret', () => {
  beforeEach(() => {
    __setSecretStoreForTests(memoryStore());
  });

  it('resolves strings, inline values, handles and external references', async () => {
    const { id } = storeSecretHandle({ value: 'handled' });
    expect(await resolveKafkaSecret('plain')).toBe('plain');
    expect(await resolveKafkaSecret({ kind: 'inline', value: 'inl' })).toBe('inl');
    expect(await resolveKafkaSecret({ kind: 'handle', id })).toBe('handled');
    expect(await resolveKafkaSecret({ kind: 'handle', id: 'nope' })).toBeUndefined();
    expect(
      await resolveKafkaSecret({
        kind: 'external',
        provider: 'aws-secrets-manager',
        profileId: 'p',
        secretId: 's',
      })
    ).toBe('from-vault');
  });
});
