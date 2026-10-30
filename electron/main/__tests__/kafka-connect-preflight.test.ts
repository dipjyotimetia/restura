// @vitest-environment node
//
// SEC-K3: the Kafka connect payload carries stored credentials as broker-secret
// handles and TLS material as file paths; main resolves both right before the
// clients are built. A handle resolves only when it is bound to THIS
// connection's field (or stored with the `kafka` scope), and a missing handle
// fails explicitly instead of sending an empty credential.

import { kafkaBoundSecretHandleId } from '@shared/protocol/broker-secret-id';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadTls = vi.hoisted(() =>
  vi.fn(async (tls: Record<string, unknown>) => {
    const { caPath, certPath, keyPath, ...rest } = tls as {
      caPath?: string;
      certPath?: string;
      keyPath?: string;
    };
    return {
      ...rest,
      ...(caPath ? { ca: `PEM(${caPath})` } : {}),
      ...(certPath ? { cert: `PEM(${certPath})` } : {}),
      ...(keyPath ? { key: `PEM(${keyPath})` } : {}),
    };
  })
);

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock('../security/encrypted-key', () => ({
  getOrCreateEncryptedKey: vi.fn(() => 'test-encryption-key'),
  getKeyStoreStatus: vi.fn(() => ({ mode: 'safeStorage', plaintextStores: [] })),
}));
vi.mock('../security/broker-tls-files', () => ({ loadBrokerTlsFiles: mockLoadTls }));

import { buildClientOptions } from '../handlers/kafka/client-options';
import { MISSING_KAFKA_CREDENTIAL, resolveKafkaConnect } from '../handlers/kafka/connect-preflight';
import type { KafkaConnectConfig } from '../ipc/validators/kafka';
import { setExecutionPolicy } from '../security/execution-policy';
import { __setSecretStoreForTests, storeSecretHandle } from '../security/secret-handle-store';

const records = new Map<string, unknown>();
__setSecretStoreForTests({
  get: (key: string) => records.get(key) as never,
  set: (key: string, value: unknown) => void records.set(key, value),
  delete: (key: string) => void records.delete(key),
  clear: () => records.clear(),
  has: (key: string) => records.has(key),
  get store() {
    return Object.fromEntries(records) as never;
  },
});

const handle = (id: string) => ({ kind: 'handle' as const, id });

function cfg(overrides: Partial<KafkaConnectConfig> = {}): KafkaConnectConfig {
  return {
    connectionId: 'conn-1',
    clientId: 'restura',
    bootstrapBrokers: ['broker.example.com:9093'],
    auth: { securityProtocol: 'PLAINTEXT' },
    ...overrides,
  };
}

describe('resolveKafkaConnect (SEC-K3)', () => {
  beforeEach(() => {
    records.clear();
    mockLoadTls.mockClear();
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: true },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
  });

  it('resolves the bound SASL password, TLS passphrase and registry password handles', async () => {
    const pw = kafkaBoundSecretHandleId('conn-1', 'sasl-password');
    const pass = kafkaBoundSecretHandleId('conn-1', 'tls-passphrase');
    const reg = kafkaBoundSecretHandleId('conn-1', 'registry-password');
    storeSecretHandle({ id: pw, value: 's3cret' });
    storeSecretHandle({ id: pass, value: 'key-pass' });
    storeSecretHandle({ id: reg, value: 'reg-pw' });

    const out = await resolveKafkaConnect(
      cfg({
        auth: {
          securityProtocol: 'SASL_SSL',
          sasl: { mechanism: 'SCRAM-SHA-512', username: 'u', password: handle(pw) },
          tls: { caPath: '/home/u/ca.pem', keyPath: '/home/u/k.pem', passphrase: handle(pass) },
        },
        registry: {
          url: 'https://sr.example.com',
          auth: { type: 'basic', username: 'r', password: handle(reg) },
        },
      })
    );

    expect(out.auth).toEqual({
      securityProtocol: 'SASL_SSL',
      sasl: { mechanism: 'SCRAM-SHA-512', username: 'u', password: 's3cret' },
      tls: { ca: 'PEM(/home/u/ca.pem)', key: 'PEM(/home/u/k.pem)', passphrase: 'key-pass' },
    });
    expect(out.registry?.auth).toMatchObject({ username: 'r', password: 'reg-pw' });
    // TLS files are read in main, by path.
    expect(mockLoadTls).toHaveBeenCalledWith(
      expect.objectContaining({ caPath: '/home/u/ca.pem', keyPath: '/home/u/k.pem' })
    );

    const client = buildClientOptions(out);
    expect(client.sasl).toMatchObject({ password: 's3cret' });
    expect(client.tls).toMatchObject({
      ca: 'PEM(/home/u/ca.pem)',
      key: 'PEM(/home/u/k.pem)',
      passphrase: 'key-pass',
    });
  });

  it('resolves a static OAUTHBEARER token and a bound registry bearer token', async () => {
    const tok = kafkaBoundSecretHandleId('conn-1', 'oauth-token');
    const bearer = kafkaBoundSecretHandleId('conn-1', 'registry-token');
    storeSecretHandle({ id: tok, value: 'jwt' });
    storeSecretHandle({ id: bearer, value: 'sr-token' });
    const out = await resolveKafkaConnect(
      cfg({
        auth: {
          securityProtocol: 'SASL_PLAINTEXT',
          sasl: { mechanism: 'OAUTHBEARER', token: handle(tok) },
        },
        registry: {
          url: 'https://sr.example.com',
          auth: { type: 'bearer', token: handle(bearer) },
        },
      })
    );
    expect(out.auth).toMatchObject({ sasl: { token: 'jwt' } });
    expect(out.registry?.auth).toEqual({ type: 'bearer', token: 'sr-token' });
  });

  it('fails explicitly when a stored credential handle is gone (never sends empty)', async () => {
    const pw = kafkaBoundSecretHandleId('conn-1', 'sasl-password');
    await expect(
      resolveKafkaConnect(
        cfg({
          auth: {
            securityProtocol: 'SASL_PLAINTEXT',
            sasl: { mechanism: 'PLAIN', username: 'u', password: handle(pw) },
          },
        })
      )
    ).rejects.toThrow(MISSING_KAFKA_CREDENTIAL);
    expect(MISSING_KAFKA_CREDENTIAL).toBe('Stored Kafka credential is missing — re-enter it');
  });

  it("refuses another connection's or another feature's handle", async () => {
    const other = kafkaBoundSecretHandleId('conn-2', 'sasl-password');
    storeSecretHandle({ id: other, value: 'not-yours' });
    storeSecretHandle({ id: 'http-handle', value: 'http-secret', scope: 'http' });
    for (const id of [other, 'http-handle']) {
      await expect(
        resolveKafkaConnect(
          cfg({
            auth: {
              securityProtocol: 'SASL_PLAINTEXT',
              sasl: { mechanism: 'PLAIN', username: 'u', password: handle(id) },
            },
          })
        )
      ).rejects.toThrow('not available to Kafka connections');
    }
  });

  it('accepts a kafka-scoped handle and passes legacy plaintext through', async () => {
    storeSecretHandle({ id: 'kafka-handle', value: 'scoped', scope: 'kafka' });
    const scoped = await resolveKafkaConnect(
      cfg({
        auth: {
          securityProtocol: 'SASL_PLAINTEXT',
          sasl: { mechanism: 'PLAIN', username: 'u', password: handle('kafka-handle') },
        },
      })
    );
    expect(scoped.auth).toMatchObject({ sasl: { password: 'scoped' } });
    const plain = await resolveKafkaConnect(
      cfg({
        auth: {
          securityProtocol: 'SASL_PLAINTEXT',
          sasl: { mechanism: 'PLAIN', username: 'u', password: 'inline-pw' },
        },
      })
    );
    expect(plain.auth).toMatchObject({ sasl: { password: 'inline-pw' } });
  });

  it('leaves an unbound registry bearer handle for the registry client to scope-check', async () => {
    const out = await resolveKafkaConnect(
      cfg({
        registry: {
          url: 'https://sr.example.com',
          auth: { type: 'bearer', token: handle('some-keychain-handle') },
        },
      })
    );
    expect(out.registry?.auth).toEqual({ type: 'bearer', token: handle('some-keychain-handle') });
  });

  it('buildClientOptions refuses an unresolved handle or unread TLS path', () => {
    expect(() =>
      buildClientOptions(
        cfg({
          auth: {
            securityProtocol: 'SASL_PLAINTEXT',
            sasl: { mechanism: 'PLAIN', username: 'u', password: handle('x') },
          },
        })
      )
    ).toThrow(MISSING_KAFKA_CREDENTIAL);
    expect(() =>
      buildClientOptions(cfg({ auth: { securityProtocol: 'SSL', tls: { caPath: '/home/u/ca' } } }))
    ).toThrow('Kafka TLS files were not loaded');
  });
});
