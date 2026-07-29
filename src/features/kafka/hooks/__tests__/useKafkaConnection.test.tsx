import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeTabId: 'kafka-tab',
  isElectron: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  setSecret: vi.fn(),
  openFile: vi.fn(),
  electronApi: null as null | { dialog: { openFile: typeof vi.fn } },
}));

vi.mock('@/store/selectors', () => ({
  useActiveTabId: () => mocks.activeTabId,
}));
vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: () => mocks.electronApi,
  isElectron: () => mocks.isElectron,
}));
vi.mock('@/lib/shared/secure-storage', () => ({
  secureStorage: { set: mocks.setSecret },
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
    mocks.setSecret.mockReset();
    mocks.openFile.mockReset();
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
      'sasl-secret'
    );
    expect(mocks.setSecret).toHaveBeenCalledWith(
      `kafka:${connection.id}:tls-passphrase`,
      'tls-secret'
    );
    expect(mocks.setSecret).toHaveBeenCalledWith(
      `kafka:${connection.id}:registry-password`,
      'registry-secret'
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
      'oauth-token'
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
});
