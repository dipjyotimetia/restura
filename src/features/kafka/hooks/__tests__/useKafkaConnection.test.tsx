import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeTabId: 'kafka-tab',
  isElectron: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  setSecret: vi.fn(),
  openFile: vi.fn(),
  electronApi: null as null | Record<string, unknown>,
  storeSecret: vi.fn(),
}));

vi.mock('@/store/selectors', () => ({
  useActiveTabId: () => mocks.activeTabId,
}));
vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: () => mocks.electronApi,
  isElectron: () => mocks.isElectron,
}));
// Typed connection credentials go into main-process handles (SEC-K3).
vi.mock('@/lib/shared/broker-secrets', () => ({
  putBrokerSecret: mocks.setSecret,
}));
vi.mock('@/features/kafka/lib/kafkaManager', () => ({
  kafkaManager: { connect: mocks.connect, disconnect: mocks.disconnect },
  kafkaSecretKey: (connectionId: string, field: string) => `kafka:${connectionId}:${field}`,
}));

import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '../../store/useKafkaStore';
import { useKafkaConnection } from '../useKafkaConnection';

describe('useKafkaConnection', () => {
  beforeEach(() => {
    mocks.activeTabId = 'kafka-tab';
    mocks.isElectron = true;
    mocks.connect.mockReset().mockResolvedValue({ ok: true });
    mocks.disconnect.mockReset().mockResolvedValue(undefined);
    mocks.setSecret.mockReset().mockResolvedValue(undefined);
    mocks.openFile.mockReset();
    mocks.storeSecret.mockReset();
    mocks.electronApi = null;
    useKafkaStore.setState({
      connections: {},
      activeConnectionId: null,
      connectionByTabId: {},
      messageFilter: 'all',
      searchQuery: '',
    });
  });

  it('creates a connection for the active tab only in the desktop app', () => {
    mocks.isElectron = false;
    const { result: browserResult, unmount } = renderHook(() => useKafkaConnection());

    expect(browserResult.current.isDesktop).toBe(false);
    expect(browserResult.current.connection).toBeNull();
    expect(useKafkaStore.getState().connectionByTabId).not.toHaveProperty('kafka-tab');

    unmount();
    mocks.isElectron = true;
    const { result } = renderHook(() => useKafkaConnection());

    expect(result.current.connection).toMatchObject({ status: 'disconnected' });
    expect(useKafkaStore.getState().connectionByTabId).toHaveProperty('kafka-tab');
  });

  it('stores an inline registry bearer token draft as a sentinel before connecting', async () => {
    const { result } = renderHook(() => useKafkaConnection());
    const connection = result.current.connection!;

    act(() => {
      result.current.updateConnection(connection.id, {
        registry: { url: 'https://registry.example.test', authType: 'bearer' },
      });
      result.current.setRegistryTokenDraft('bearer-secret');
    });
    await act(async () => {
      await result.current.connect();
    });

    expect(mocks.setSecret).toHaveBeenCalledWith(
      `kafka:${connection.id}:registry-token`,
      'bearer-secret',
      expect.stringContaining('Kafka')
    );
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: expect.objectContaining({
          authType: 'bearer',
          bearerToken: KAFKA_SECRET_SENTINEL,
        }),
      })
    );
    expect(result.current.registryTokenDraft).toBe('');
  });

  it('stores connection secret drafts as sentinels before connecting', async () => {
    const { result } = renderHook(() => useKafkaConnection());
    const connection = result.current.connection!;

    act(() => {
      result.current.updateAuth(connection.id, {
        securityProtocol: 'SASL_SSL',
        sasl: { mechanism: 'PLAIN', username: 'alice', password: '' },
      });
      result.current.updateConnection(connection.id, {
        registry: { url: 'https://registry.example.test' },
      });
      result.current.setSaslPasswordDraft('sasl-secret');
      result.current.setTlsPassphraseDraft('tls-secret');
      result.current.setRegistryPasswordDraft('registry-secret');
    });

    await act(async () => {
      await result.current.connect();
    });

    expect(mocks.setSecret).toHaveBeenCalledWith(
      `kafka:${connection.id}:sasl-password`,
      'sasl-secret',
      expect.stringContaining('Kafka')
    );
    expect(mocks.setSecret).toHaveBeenCalledWith(
      `kafka:${connection.id}:tls-passphrase`,
      'tls-secret',
      expect.stringContaining('Kafka')
    );
    expect(mocks.setSecret).toHaveBeenCalledWith(
      `kafka:${connection.id}:registry-password`,
      'registry-secret',
      expect.stringContaining('Kafka')
    );
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          sasl: expect.objectContaining({ password: KAFKA_SECRET_SENTINEL }),
          tls: expect.objectContaining({ passphrase: KAFKA_SECRET_SENTINEL }),
        }),
        registry: expect.objectContaining({
          auth: expect.objectContaining({ password: KAFKA_SECRET_SENTINEL }),
        }),
      })
    );
  });

  it('awaits the handle write before connecting and stops when it fails', async () => {
    const order: string[] = [];
    mocks.setSecret.mockImplementation(async () => {
      await Promise.resolve();
      order.push('stored');
    });
    mocks.connect.mockImplementation(async () => {
      order.push('connect');
      return { ok: true };
    });
    const { result } = renderHook(() => useKafkaConnection());
    const connection = result.current.connection!;
    act(() => {
      result.current.updateAuth(connection.id, {
        securityProtocol: 'SASL_PLAINTEXT',
        sasl: { mechanism: 'PLAIN', username: 'alice', password: '' },
      });
      result.current.setSaslPasswordDraft('sasl-secret');
    });
    await act(async () => result.current.connect());
    expect(order).toEqual(['stored', 'connect']);

    mocks.connect.mockClear();
    mocks.setSecret.mockRejectedValueOnce(new Error('Secure secret storage is unavailable'));
    act(() => result.current.setSaslPasswordDraft('again'));
    await act(async () => result.current.connect());
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(useKafkaStore.getState().connections[connection.id]!.messages.at(-1)?.error).toBe(
      'Secure secret storage is unavailable'
    );
  });

  it('supports OAuth secrets, broker edits, registry patches, TLS files, and disconnect', async () => {
    const { result } = renderHook(() => useKafkaConnection());
    const connection = result.current.connection!;

    act(() => {
      result.current.updateAuth(connection.id, {
        securityProtocol: 'SASL_SSL',
        sasl: {
          mechanism: 'OAUTHBEARER',
          token: '',
          extensions: { tenant: 'restura' },
        },
      });
      result.current.updateConnection(connection.id, {
        registry: { url: 'https://registry.example.test' },
      });
      result.current.setSaslPasswordDraft('oauth-token');
    });
    await act(async () => result.current.connect());
    expect(mocks.setSecret).toHaveBeenCalledWith(
      `kafka:${connection.id}:oauth-token`,
      'oauth-token',
      expect.stringContaining('Kafka')
    );
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          sasl: {
            mechanism: 'OAUTHBEARER',
            token: KAFKA_SECRET_SENTINEL,
            extensions: { tenant: 'restura' },
          },
        }),
      })
    );

    act(() => result.current.setBrokerDraft(' broker-2:9092 '));
    act(() => result.current.addBroker());
    expect(result.current.connection?.bootstrapBrokers).toContain('broker-2:9092');
    act(() => result.current.removeBroker(0));
    expect(result.current.connection?.bootstrapBrokers).toEqual(['broker-2:9092']);

    act(() => result.current.patchRegistry({ auth: { username: 'alice', password: '' } }));
    expect(result.current.connection?.registry).toMatchObject({
      auth: { username: 'alice', password: '' },
    });

    act(() => result.current.setSecurityProtocol('SASL_PLAINTEXT'));
    expect(result.current.connection?.auth.sasl?.mechanism).toBe('OAUTHBEARER');
    act(() => result.current.setSecurityProtocol('SSL'));
    expect(result.current.connection?.auth.tls).toEqual({});
    act(() => result.current.setSecurityProtocol('PLAINTEXT'));
    expect(result.current.connection?.auth).toEqual({ securityProtocol: 'PLAINTEXT' });

    mocks.electronApi = { dialog: { openFile: mocks.openFile } };
    mocks.openFile.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/client.pem'],
    });
    await act(async () => result.current.pickTlsFile('certPath'));
    expect(result.current.connection?.auth.tls?.certPath).toBe('/tmp/client.pem');

    await act(async () => result.current.disconnect());
    expect(mocks.disconnect).toHaveBeenCalledWith(connection.id);
  });

  it('stores OAuth client-credentials and MSK IAM secrets as SecretRef handles before connecting', async () => {
    mocks.electronApi = { secrets: { store: mocks.storeSecret } };
    mocks.storeSecret.mockImplementation(async (args: { id?: string }) => ({
      ok: true,
      id: args.id ?? 'handle-1',
    }));
    const { result } = renderHook(() => useKafkaConnection());
    const connection = result.current.connection!;

    act(() => {
      result.current.updateAuth(connection.id, {
        securityProtocol: 'SASL_SSL',
        sasl: {
          mechanism: 'OAUTHBEARER',
          mode: 'client-credentials',
          tokenEndpoint: 'https://idp.example.com/token',
          clientId: 'cid',
        },
      });
      result.current.setSecretDraft('oauthClientSecret', 'client-secret');
    });
    expect(result.current.secretDrafts).toEqual({ oauthClientSecret: 'client-secret' });

    await act(async () => result.current.connect());

    expect(mocks.storeSecret).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'client-secret', scope: 'kafka' })
    );
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          sasl: expect.objectContaining({
            clientSecret: expect.objectContaining({ kind: 'handle', id: 'handle-1' }),
          }),
        }),
      })
    );
    // The store holds only the handle; the draft is cleared.
    expect(JSON.stringify(useKafkaStore.getState().connections[connection.id])).not.toContain(
      'client-secret"'
    );
    expect(result.current.secretDrafts).toEqual({});
  });

  it('aborts the connect with a visible error when the secret cannot be stored', async () => {
    mocks.electronApi = { secrets: { store: mocks.storeSecret } };
    mocks.storeSecret.mockResolvedValue({ ok: false, error: 'keychain locked' });
    const { result } = renderHook(() => useKafkaConnection());
    const connection = result.current.connection!;

    act(() => {
      result.current.updateConnection(connection.id, {
        bootstrapBrokers: ['b-1.demo.c2.kafka.us-east-1.amazonaws.com:9098'],
      });
      result.current.updateAuth(connection.id, {
        securityProtocol: 'SASL_SSL',
        sasl: {
          mechanism: 'AWS_MSK_IAM',
          region: 'us-east-1',
          credentialSource: 'static',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        },
      });
      result.current.setSecretDraft('awsSecretAccessKey', 'aws-secret');
    });
    await act(async () => result.current.connect());

    expect(mocks.connect).not.toHaveBeenCalled();
    const messages = useKafkaStore.getState().connections[connection.id]!.messages;
    expect(messages.at(-1)).toMatchObject({
      direction: 'system',
      error: expect.stringContaining('keychain locked'),
    });
  });

  it('replaceSasl discards drafts, deletes orphaned handles and forces SASL_SSL for MSK IAM', async () => {
    const deleteSecret = vi.fn(async () => ({ ok: true }));
    mocks.electronApi = { secrets: { store: mocks.storeSecret, delete: deleteSecret } };
    const { result } = renderHook(() => useKafkaConnection());
    const connection = result.current.connection!;
    const handle = { kind: 'handle' as const, id: 'old-handle' };

    act(() => {
      result.current.updateAuth(connection.id, {
        securityProtocol: 'SASL_PLAINTEXT',
        sasl: {
          mechanism: 'OAUTHBEARER',
          mode: 'client-credentials',
          tokenEndpoint: 'https://idp/token',
          clientId: 'c',
          clientSecret: handle,
        },
      });
      result.current.setSaslPasswordDraft('typed');
      result.current.setSecretDraft('oauthClientSecret', 'typed-secret');
    });

    // Field-level edits that keep the handle do not delete it.
    act(() =>
      result.current.replaceSasl({
        mechanism: 'OAUTHBEARER',
        mode: 'client-credentials',
        tokenEndpoint: 'https://idp/token2',
        clientId: 'c',
        clientSecret: handle,
      })
    );
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(result.current.secretDrafts).toEqual({});
    expect(result.current.saslPasswordDraft).toBe('');

    act(() =>
      result.current.replaceSasl({
        mechanism: 'AWS_MSK_IAM',
        region: 'us-east-1',
        credentialSource: 'profile',
      })
    );
    expect(deleteSecret).toHaveBeenCalledWith('old-handle');
    expect(result.current.connection?.auth.securityProtocol).toBe('SASL_SSL');
    expect(result.current.connection?.auth.tls).toEqual({});

    // Without an Electron API there is nothing to delete; the switch still applies.
    mocks.electronApi = null;
    act(() => result.current.replaceSasl({ mechanism: 'PLAIN', username: '', password: '' }));
    expect(result.current.connection?.auth.sasl?.mechanism).toBe('PLAIN');
    expect(result.current.connection?.auth.securityProtocol).toBe('SASL_SSL');
  });

  it('blocks connect with an inline reason when MSK IAM preconditions fail', async () => {
    const { result } = renderHook(() => useKafkaConnection());
    const connection = result.current.connection!;
    act(() => {
      result.current.updateAuth(connection.id, {
        securityProtocol: 'SASL_PLAINTEXT',
        sasl: {
          mechanism: 'AWS_MSK_IAM',
          region: 'us-east-1',
          credentialSource: 'profile',
          profile: 'p',
        },
      });
    });
    await act(async () => result.current.connect());
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(useKafkaStore.getState().connections[connection.id]!.messages.at(-1)).toMatchObject({
      error: expect.stringContaining('requires the SASL_SSL'),
    });
  });
});
