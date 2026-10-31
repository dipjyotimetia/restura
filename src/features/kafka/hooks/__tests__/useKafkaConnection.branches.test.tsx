import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeTabId: 'kafka-tab' as string | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  setSecret: vi.fn(),
  openFile: vi.fn(),
  electronApi: null as null | Record<string, unknown>,
}));

vi.mock('@/store/selectors', () => ({
  useActiveTabId: () => mocks.activeTabId,
}));
vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: () => mocks.electronApi,
  isElectron: () => true,
}));
vi.mock('@/lib/shared/broker-secrets', () => ({
  putBrokerSecret: mocks.setSecret,
}));
vi.mock('@/features/kafka/lib/kafkaManager', () => ({
  kafkaManager: { connect: mocks.connect, disconnect: mocks.disconnect },
  kafkaSecretKey: (connectionId: string, field: string) => `kafka:${connectionId}:${field}`,
}));

import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '../../store/useKafkaStore';
import { useKafkaConnection } from '../useKafkaConnection';

function lastError(id: string): string | undefined {
  return useKafkaStore.getState().connections[id]?.messages.at(-1)?.error;
}

describe('useKafkaConnection branches', () => {
  beforeEach(() => {
    mocks.activeTabId = 'kafka-tab';
    mocks.connect.mockReset().mockResolvedValue({ ok: true });
    mocks.disconnect.mockReset().mockResolvedValue(undefined);
    mocks.setSecret.mockReset().mockResolvedValue(undefined);
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

  describe('without an active tab', () => {
    it('is inert: every action is a no-op', async () => {
      mocks.activeTabId = null;
      const { result } = renderHook(() => useKafkaConnection());
      expect(result.current.activeConnectionId).toBeNull();
      expect(result.current.connection).toBeNull();

      await act(async () => {
        await result.current.connect();
        await result.current.disconnect();
        await result.current.pickTlsFile('caPath');
      });
      act(() => {
        result.current.addBroker();
        result.current.removeBroker(0);
        result.current.patchRegistry({ url: 'x' });
        result.current.setSecurityProtocol('SSL');
        result.current.replaceSasl({ mechanism: 'GSSAPI' });
      });
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.disconnect).not.toHaveBeenCalled();
      expect(Object.keys(useKafkaStore.getState().connections)).toHaveLength(0);
    });
  });

  describe('with a connection', () => {
    it('ignores blank brokers and registry patches when no registry is configured', () => {
      const { result } = renderHook(() => useKafkaConnection());
      const connection = result.current.connection!;
      const before = [...connection.bootstrapBrokers];

      act(() => {
        result.current.setBrokerDraft('   ');
      });
      act(() => {
        result.current.addBroker();
      });
      expect(result.current.connection?.bootstrapBrokers).toEqual(before);

      act(() => {
        result.current.patchRegistry({ url: 'https://x' });
      });
      expect(result.current.connection?.registry).toBeUndefined();
    });

    it('keeps the pre-existing SASL block when switching security protocol, and defaults to PLAIN', () => {
      const { result } = renderHook(() => useKafkaConnection());
      act(() => {
        result.current.setSecurityProtocol('SASL_SSL');
      });
      expect(result.current.connection?.auth.sasl).toMatchObject({ mechanism: 'PLAIN' });
      expect(result.current.connection?.auth.tls).toEqual({});

      act(() => {
        result.current.updateAuth(result.current.connection!.id, {
          securityProtocol: 'SASL_SSL',
          sasl: { mechanism: 'SCRAM-SHA-256', username: 'u', password: '' },
          tls: { caPath: '/ca' },
        });
      });
      act(() => {
        result.current.setSecurityProtocol('SSL');
      });
      expect(result.current.connection?.auth).toEqual({
        securityProtocol: 'SSL',
        tls: { caPath: '/ca' },
      });
    });

    it('does not touch TLS paths when the file dialog is cancelled, empty or unavailable', async () => {
      const { result } = renderHook(() => useKafkaConnection());

      await act(async () => result.current.pickTlsFile('caPath'));
      expect(result.current.connection?.auth.tls).toBeUndefined();

      mocks.electronApi = { dialog: { openFile: mocks.openFile } };
      mocks.openFile.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      await act(async () => result.current.pickTlsFile('caPath'));
      mocks.openFile.mockResolvedValueOnce({ canceled: false, filePaths: [] });
      await act(async () => result.current.pickTlsFile('keyPath'));
      expect(result.current.connection?.auth.tls).toBeUndefined();

      mocks.openFile.mockResolvedValueOnce({ canceled: false, filePaths: ['/k.pem'] });
      await act(async () => result.current.pickTlsFile('keyPath'));
      expect(result.current.connection?.auth.tls).toEqual({ keyPath: '/k.pem' });
    });

    it('replaceSasl works without a secrets bridge and ignores handles it still needs', () => {
      const deleteSecret = vi.fn(async () => ({ ok: true }));
      const { result } = renderHook(() => useKafkaConnection());
      const id = result.current.connection!.id;
      const handle = { kind: 'handle' as const, id: 'h1' };

      act(() => {
        result.current.updateAuth(id, {
          securityProtocol: 'SASL_SSL',
          sasl: {
            mechanism: 'OAUTHBEARER',
            mode: 'client-credentials',
            tokenEndpoint: 'https://idp',
            clientId: 'c',
            clientSecret: handle,
          },
        });
      });
      // No electron API at all: orphan deletion is skipped without throwing.
      act(() => {
        result.current.replaceSasl({ mechanism: 'GSSAPI' });
      });
      expect(result.current.connection?.auth.sasl).toEqual({ mechanism: 'GSSAPI' });

      mocks.electronApi = { secrets: { delete: deleteSecret } };
      act(() => {
        result.current.updateAuth(id, {
          securityProtocol: 'SASL_SSL',
          sasl: {
            mechanism: 'OAUTHBEARER',
            mode: 'client-credentials',
            tokenEndpoint: 'https://idp',
            clientId: 'c',
            clientSecret: handle,
          },
        });
      });
      // Same handle retained: not deleted.
      act(() => {
        result.current.replaceSasl({
          mechanism: 'OAUTHBEARER',
          mode: 'client-credentials',
          tokenEndpoint: 'https://other',
          clientId: 'c',
          clientSecret: handle,
        });
      });
      expect(deleteSecret).not.toHaveBeenCalled();
      // MSK IAM on an already SASL_SSL connection keeps the protocol and TLS.
      act(() => {
        result.current.replaceSasl({
          mechanism: 'AWS_MSK_IAM',
          region: 'us-east-1',
          credentialSource: 'profile',
          profile: 'dev',
        });
      });
      expect(result.current.connection?.auth.securityProtocol).toBe('SASL_SSL');
    });

    it('stops connecting and reports when a TLS passphrase cannot be stored, keeping earlier auth edits', async () => {
      const { result } = renderHook(() => useKafkaConnection());
      const id = result.current.connection!.id;
      act(() => {
        result.current.updateAuth(id, {
          securityProtocol: 'SASL_SSL',
          sasl: { mechanism: 'PLAIN', username: 'u', password: '' },
        });
        result.current.setSaslPasswordDraft('pw');
        result.current.setTlsPassphraseDraft('tls');
      });
      mocks.setSecret.mockImplementation(async (key: string) => {
        if (key.endsWith('tls-passphrase')) throw 'disk full';
      });
      await act(async () => result.current.connect());

      expect(mocks.connect).not.toHaveBeenCalled();
      expect(lastError(id)).toBe('Failed to store Kafka credentials');
      expect(result.current.connection?.auth.sasl).toMatchObject({
        password: KAFKA_SECRET_SENTINEL,
      });
    });

    it('stops connecting when the TLS passphrase fails and nothing else changed', async () => {
      const { result } = renderHook(() => useKafkaConnection());
      const id = result.current.connection!.id;
      act(() => {
        result.current.updateAuth(id, { securityProtocol: 'SSL', tls: {} });
        result.current.setTlsPassphraseDraft('tls');
      });
      mocks.setSecret.mockRejectedValue(new Error('locked'));
      await act(async () => result.current.connect());
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(lastError(id)).toBe('locked');
    });

    it('stops connecting when the registry password or bearer token cannot be stored', async () => {
      const { result } = renderHook(() => useKafkaConnection());
      const id = result.current.connection!.id;
      act(() => {
        result.current.updateConnection(id, { registry: { url: 'https://reg' } });
        result.current.setRegistryPasswordDraft('rp');
      });
      mocks.setSecret.mockRejectedValueOnce(new Error('pw locked'));
      await act(async () => result.current.connect());
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(lastError(id)).toBe('pw locked');

      act(() => {
        result.current.setRegistryPasswordDraft('');
        result.current.setRegistryTokenDraft('tok');
      });
      mocks.setSecret.mockRejectedValueOnce(new Error('tok locked'));
      await act(async () => result.current.connect());
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(lastError(id)).toBe('tok locked');
    });

    it('reports a failure persisting SASL handle secrets without a secrets bridge', async () => {
      const { result } = renderHook(() => useKafkaConnection());
      const id = result.current.connection!.id;
      act(() => {
        result.current.updateAuth(id, {
          securityProtocol: 'SASL_SSL',
          sasl: {
            mechanism: 'OAUTHBEARER',
            mode: 'client-credentials',
            tokenEndpoint: 'https://idp',
            clientId: 'c',
            clientSecret: { kind: 'handle', id: 'h-existing' },
          },
        });
        result.current.setSecretDraft('oauthClientSecret', 'typed');
      });
      await act(async () => result.current.connect());
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(lastError(id)).toBe('Secure secret storage is unavailable.');
    });

    it('stores a typed registry password even when the registry already has basic auth', async () => {
      const { result } = renderHook(() => useKafkaConnection());
      const id = result.current.connection!.id;
      act(() => {
        result.current.updateConnection(id, {
          registry: { url: 'https://reg', auth: { username: 'bob', password: '' } },
        });
        result.current.setRegistryPasswordDraft('pw');
      });
      await act(async () => result.current.connect());
      expect(mocks.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          registry: expect.objectContaining({
            auth: { username: 'bob', password: KAFKA_SECRET_SENTINEL },
          }),
        })
      );
    });

    it('resolves {{var}} brokers at connect time without rewriting the stored list', async () => {
      const { result } = renderHook(() => useKafkaConnection());
      const id = result.current.connection!.id;
      act(() => {
        result.current.updateConnection(id, { bootstrapBrokers: ['{{nope}}:9092'] });
      });
      await act(async () => result.current.connect());
      expect(mocks.connect).toHaveBeenCalledTimes(1);
      expect(result.current.connection?.bootstrapBrokers).toEqual(['{{nope}}:9092']);
    });

    it('mirrors typed secrets as pending drafts for OAuth connections and clears them on unmount', () => {
      const { result, unmount } = renderHook(() => useKafkaConnection());
      const id = result.current.connection!.id;
      act(() => {
        result.current.updateAuth(id, {
          securityProtocol: 'SASL_SSL',
          sasl: { mechanism: 'OAUTHBEARER', token: '' },
        });
      });
      act(() => {
        result.current.setSaslPasswordDraft('t');
      });
      act(() => {
        result.current.setTlsPassphraseDraft('p');
      });
      unmount();
      expect(Object.keys(useKafkaStore.getState().connections)).toContain(id);
    });

    it('switches to a different connection when the tab changes', () => {
      const { result, rerender } = renderHook(() => useKafkaConnection());
      const first = result.current.connection!.id;
      act(() => {
        result.current.setBrokerDraft('x:1');
      });
      mocks.activeTabId = 'other-tab';
      rerender();
      expect(result.current.connection?.id).not.toBe(first);
      expect(result.current.brokerDraft).toBe('');
    });
  });
});
