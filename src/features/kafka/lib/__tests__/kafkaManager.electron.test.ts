import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { KAFKA_CHANNEL, kafkaChannel } from '../../../../../electron/shared/kafka-channels';

function installElectronMock() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const kafka = {
    connect: vi.fn(async () => ({ success: true as const })),
    produce: vi.fn(),
    subscribe: vi.fn(async () => ({ success: true as const })),
    unsubscribe: vi.fn(),
    disconnect: vi.fn(),
    listTopics: vi.fn(),
    createTopic: vi.fn(),
    deleteTopic: vi.fn(),
    listGroups: vi.fn(),
    inspectTopic: vi.fn(),
    inspectGroup: vi.fn(),
    resetGroupOffsets: vi.fn(),
    deleteGroup: vi.fn(),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      const callbacks = listeners.get(channel) ?? [];
      callbacks.push(callback);
      listeners.set(channel, callbacks);
    },
    removeListener: vi.fn(),
    removeAllListeners: (channel: string) => listeners.delete(channel),
  };
  const readFile = vi.fn(async () => ({ success: true, content: 'pem-data' }));
  Object.defineProperty(window, 'electron', {
    value: { isElectron: true, kafka, fs: { readFile } },
    configurable: true,
  });
  return {
    kafka,
    readFile,
    handlerCount: (channel: string) => listeners.get(channel)?.length ?? 0,
    emit: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}

function resetStore(): void {
  useKafkaStore.setState({
    connections: {},
    activeConnectionId: null,
    connectionByTabId: {},
    messageFilter: 'all',
    searchQuery: '',
  });
}

describe('kafkaManager (Electron path)', () => {
  beforeEach(resetStore);

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('does not stack lifecycle listeners when reconnecting the same connection', async () => {
    const { handlerCount } = installElectronMock();
    const id = useKafkaStore.getState().createConnection();
    const connection = useKafkaStore.getState().connections[id]!;

    await kafkaManager.connect(connection);
    await kafkaManager.connect(connection);

    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.CLOSE, id))).toBe(1);
    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.ERROR, id))).toBe(1);
    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, id))).toBe(1);
  });

  it('resets state and listeners when the connect IPC rejects', async () => {
    const { kafka, handlerCount } = installElectronMock();
    kafka.connect.mockRejectedValueOnce(new Error('IPC unavailable'));
    const id = useKafkaStore.getState().createConnection();

    const result = await kafkaManager.connect(useKafkaStore.getState().connections[id]!);

    expect(result).toEqual({ ok: false, error: 'IPC unavailable' });
    expect(useKafkaStore.getState().connections[id]!.status).toBe('disconnected');
    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.CLOSE, id))).toBe(0);
  });

  it('forwards explicit payload encodings to Electron and records them for a sent message', async () => {
    const { kafka } = installElectronMock();
    kafka.produce.mockResolvedValueOnce({
      success: true,
      ack: { topic: 'orders', partition: 0, offset: '7', timestamp: 123 },
    });
    const id = useKafkaStore.getState().createConnection();

    await expect(
      kafkaManager.produce({
        connectionId: id,
        topic: 'orders',
        key: '/w==',
        keyEncoding: 'base64',
        value: '/4AB',
        valueEncoding: 'base64',
        acks: 1,
      })
    ).resolves.toEqual({
      ok: true,
      ack: { topic: 'orders', partition: 0, offset: '7', timestamp: 123 },
    });

    expect(kafka.produce).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          key: { encoding: 'base64', data: '/w==' },
          value: { encoding: 'base64', data: '/4AB' },
        }),
      })
    );
    expect(useKafkaStore.getState().connections[id]!.messages[0]).toMatchObject({
      keyEncoding: 'base64',
      valueEncoding: 'base64',
    });
  });

  it('preserves Kafka null values as visible tombstones in sent and received messages', async () => {
    const { kafka, emit } = installElectronMock();
    kafka.produce.mockResolvedValueOnce({
      success: true,
      ack: { topic: 'orders', partition: 0, offset: '7', timestamp: 123 },
    });
    const id = useKafkaStore.getState().createConnection();
    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    await kafkaManager.subscribe({
      connectionId: id,
      groupId: 'restura-test',
      topics: ['orders'],
      fromBeginning: false,
    });

    await kafkaManager.produce({
      connectionId: id,
      topic: 'orders',
      value: null,
      acks: 1,
    });
    emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), {
      topic: 'orders',
      partition: 0,
      offset: '7',
      value: '',
      tombstone: true,
      timestamp: 123,
    });

    expect(useKafkaStore.getState().connections[id]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: 'sent', value: '<tombstone>', tombstone: true }),
        expect.objectContaining({ direction: 'received', value: '<tombstone>', tombstone: true }),
      ])
    );
  });

  it('resolves OAuth, transactional, registry, and TLS options before IPC', async () => {
    const { kafka, readFile } = installElectronMock();
    const id = useKafkaStore.getState().createConnection();
    const store = useKafkaStore.getState();
    store.updateAuth(id, {
      securityProtocol: 'SASL_PLAINTEXT',
      sasl: {
        mechanism: 'OAUTHBEARER',
        token: 'oauth-token',
        extensions: { tenant: 'restura' },
      },
    });
    store.updateConnection(id, {
      idempotent: true,
      transactionalId: 'txn-restura',
      registry: {
        url: 'https://registry.example.test',
        auth: { username: 'restura', password: 'registry-password' },
      },
    });

    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    expect(kafka.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotent: true,
        transactionalId: 'txn-restura',
        auth: {
          securityProtocol: 'SASL_PLAINTEXT',
          sasl: {
            mechanism: 'OAUTHBEARER',
            token: 'oauth-token',
            extensions: { tenant: 'restura' },
          },
        },
        registry: {
          url: 'https://registry.example.test',
          auth: { username: 'restura', password: 'registry-password' },
        },
      })
    );

    store.updateAuth(id, {
      securityProtocol: 'SSL',
      tls: {
        caPath: '/tmp/ca.pem',
        certPath: '/tmp/cert.pem',
        keyPath: '/tmp/key.pem',
        passphrase: 'secret',
        rejectUnauthorized: false,
      },
    });
    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(kafka.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auth: {
          securityProtocol: 'SSL',
          tls: {
            ca: 'pem-data',
            cert: 'pem-data',
            key: 'pem-data',
            passphrase: 'secret',
            rejectUnauthorized: false,
          },
        },
      })
    );
  });

  it('forwards the complete native consumer policy and lifecycle telemetry', async () => {
    const { kafka, emit } = installElectronMock();
    const id = useKafkaStore.getState().createConnection();
    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    useKafkaStore.getState().updateConsumer(id, {
      fallbackMode: 'fail',
      commitPolicy: 'manual',
      isolation: 'read-committed',
      groupProtocol: 'consumer',
      groupInstanceId: 'instance-1',
      groupRemoteAssignor: 'uniform',
      sessionTimeoutMs: 10_000,
      rebalanceTimeoutMs: 20_000,
      heartbeatIntervalMs: 3_000,
      autoCommitIntervalMs: 5_000,
      minBytes: 1,
      maxBytes: 1024,
      maxBytesPerPartition: 512,
      maxWaitTimeMs: 250,
      highWaterMark: 32,
    });

    await kafkaManager.subscribe({
      connectionId: id,
      groupId: 'restura-test',
      topics: ['orders'],
      fromBeginning: false,
      mode: 'manual',
      offsets: [{ topic: 'orders', partition: 0, offset: '4' }],
    });
    expect(kafka.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'manual',
        fallbackMode: 'fail',
        commitPolicy: 'manual',
        isolation: 'read-committed',
        groupProtocol: 'consumer',
        groupInstanceId: 'instance-1',
        groupRemoteAssignor: 'uniform',
        minBytes: 1,
        maxBytes: 1024,
        offsets: [{ topic: 'orders', partition: 0, offset: '4' }],
      })
    );

    emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, id), {});
    emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_LAG, id), {
      lag: [{ topic: 'orders', offsets: ['3'] }],
    });
    expect(useKafkaStore.getState().connections[id]!.consumer).toMatchObject({
      groupState: 'unknown',
      lag: [{ topic: 'orders', offsets: ['3'] }],
    });
  });

  it('normalizes native topic and group admin success and error responses', async () => {
    const { kafka } = installElectronMock();
    kafka.listTopics
      .mockResolvedValueOnce({ success: true, topics: ['orders'] })
      .mockResolvedValueOnce({ success: false });
    kafka.createTopic
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    kafka.deleteTopic
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    kafka.listGroups
      .mockResolvedValueOnce({ success: true, groups: [] })
      .mockResolvedValueOnce({ success: false });
    kafka.inspectTopic
      .mockResolvedValueOnce({ success: true, partitions: [], config: [] })
      .mockResolvedValueOnce({ success: false });
    kafka.inspectGroup
      .mockResolvedValueOnce({ success: true, group: undefined, offsets: [] })
      .mockResolvedValueOnce({ success: false });
    kafka.resetGroupOffsets
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    kafka.deleteGroup
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });

    await expect(kafkaManager.listTopics('c')).resolves.toEqual({ ok: true, topics: ['orders'] });
    await expect(kafkaManager.listTopics('c')).resolves.toEqual({
      ok: false,
      error: 'List topics failed',
    });
    await expect(
      kafkaManager.createTopic({
        connectionId: 'c',
        topic: 'orders',
        partitions: 1,
        replicationFactor: 1,
      })
    ).resolves.toEqual({ ok: true });
    await expect(
      kafkaManager.createTopic({
        connectionId: 'c',
        topic: 'orders',
        partitions: 1,
        replicationFactor: 1,
      })
    ).resolves.toEqual({ ok: false, error: 'Create topic failed' });
    await expect(kafkaManager.deleteTopic('c', 'orders')).resolves.toEqual({ ok: true });
    await expect(kafkaManager.deleteTopic('c', 'orders')).resolves.toEqual({
      ok: false,
      error: 'Delete topic failed',
    });
    await expect(kafkaManager.listGroups('c')).resolves.toEqual({ ok: true, groups: [] });
    await expect(kafkaManager.listGroups('c')).resolves.toEqual({
      ok: false,
      error: 'List groups failed',
    });
    await expect(kafkaManager.inspectTopic('c', 'orders')).resolves.toEqual({
      ok: true,
      partitions: [],
      config: [],
    });
    await expect(kafkaManager.inspectTopic('c', 'orders')).resolves.toEqual({
      ok: false,
      error: 'Inspect topic failed',
    });
    await expect(kafkaManager.inspectGroup('c', 'group')).resolves.toEqual({
      ok: true,
      group: null,
      offsets: [],
    });
    await expect(kafkaManager.inspectGroup('c', 'group')).resolves.toEqual({
      ok: false,
      error: 'Inspect group failed',
    });
    const reset = {
      connectionId: 'c',
      groupId: 'group',
      topic: 'orders',
      to: 'earliest' as const,
    };
    await expect(kafkaManager.resetGroupOffsets(reset)).resolves.toEqual({ ok: true });
    await expect(kafkaManager.resetGroupOffsets(reset)).resolves.toEqual({
      ok: false,
      error: 'Reset offsets failed',
    });
    await expect(kafkaManager.deleteGroup('c', 'group')).resolves.toEqual({ ok: true });
    await expect(kafkaManager.deleteGroup('c', 'group')).resolves.toEqual({
      ok: false,
      error: 'Delete group failed',
    });
  });
});
