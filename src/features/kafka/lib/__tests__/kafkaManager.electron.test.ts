import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { KAFKA_CHANNEL, kafkaChannel } from '../../../../../electron/shared/kafka-channels';
import { KAFKA_FLUSH_INTERVAL_MS } from '../consumedMessageBuffer';

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
    deleteGroupOffsets: vi.fn(),
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

  it('sends resolved values but logs the masked display copy (#984)', async () => {
    const { kafka } = installElectronMock();
    kafka.produce.mockResolvedValueOnce({
      success: true,
      ack: { topic: 'orders', partition: 0, offset: '8', timestamp: 124 },
    });
    const id = useKafkaStore.getState().createConnection();

    await kafkaManager.produce({
      connectionId: id,
      topic: 'orders',
      key: 'k-secret',
      value: 'v-secret',
      headers: { auth: 'h-secret' },
      acks: 1,
      display: { key: 'k-•', value: 'v-•', headers: { auth: 'h-•' } },
    });

    expect(kafka.produce).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({ value: { encoding: 'utf8', data: 'v-secret' } }),
      })
    );
    expect(useKafkaStore.getState().connections[id]!.messages[0]).toMatchObject({
      key: 'k-•',
      value: 'v-•',
      headers: { auth: 'h-•' },
    });
  });

  it('persists the unresolved {{var}} consumer targets, not the wire values (#984)', async () => {
    installElectronMock();
    const id = useKafkaStore.getState().createConnection();
    await kafkaManager.subscribe({
      connectionId: id,
      groupId: 'g-prod',
      topics: ['orders.prod'],
      fromBeginning: false,
      stored: { groupId: 'g-{{env}}', topics: ['orders.{{env}}'] },
    });
    expect(useKafkaStore.getState().connections[id]!.consumer).toMatchObject({
      groupId: 'g-{{env}}',
      topics: ['orders.{{env}}'],
    });
  });

  it('does not stack message listeners when re-subscribing after the consumer closed itself', async () => {
    const { emit, handlerCount } = installElectronMock();
    const id = useKafkaStore.getState().createConnection();
    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    const subscribe = () =>
      kafkaManager.subscribe({
        connectionId: id,
        groupId: 'restura-test',
        topics: ['orders'],
        fromBeginning: false,
      });
    await subscribe();
    // A browse stop-after-N (or a fetch error) closes the consumer main-side,
    // so the renderer goes idle without an unsubscribe call.
    emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, id), {});
    await subscribe();

    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id))).toBe(1);
    emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), {
      topic: 'orders',
      partition: 0,
      offset: '1',
      value: 'once',
      timestamp: 1,
    });
    // Consumed records are batched into the store (#938).
    await new Promise((r) => setTimeout(r, KAFKA_FLUSH_INTERVAL_MS + 20));
    const received = useKafkaStore
      .getState()
      .connections[id]!.messages.filter((m) => m.direction === 'received');
    expect(received.map((m) => m.value)).toEqual(['once']);
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
    await kafkaManager.unsubscribe(id);

    expect(useKafkaStore.getState().connections[id]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: 'sent', value: '<tombstone>', tombstone: true }),
        expect.objectContaining({ direction: 'received', value: '<tombstone>', tombstone: true }),
      ])
    );
  });

  describe('consumed-record batching', () => {
    const record = (offset: number, extra: Record<string, unknown> = {}) => ({
      topic: 'orders',
      partition: 0,
      offset: String(offset),
      value: `v${offset}`,
      timestamp: 1_000 + offset,
      ...extra,
    });

    async function subscribed() {
      const mock = installElectronMock();
      const id = useKafkaStore.getState().createConnection();
      await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
      await kafkaManager.subscribe({
        connectionId: id,
        groupId: 'g',
        topics: ['orders'],
        fromBeginning: false,
      });
      const received = () =>
        useKafkaStore
          .getState()
          .connections[id]!.messages.filter((m) => m.direction === 'received');
      return { ...mock, id, received };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('updates the store at most once per 100 ms per connection, in arrival order', async () => {
      vi.useFakeTimers();
      const { emit, id, received } = await subscribed();
      let updates = 0;
      const unsubscribe = useKafkaStore.subscribe(() => {
        updates += 1;
      });

      // 300 records spread across 250 ms → at most 3 flushes.
      for (let i = 0; i < 300; i += 1) {
        emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), record(i));
        if (i % 60 === 59) vi.advanceTimersByTime(50);
      }
      expect(updates).toBeLessThanOrEqual(2);
      vi.advanceTimersByTime(100);
      unsubscribe();

      expect(updates).toBeLessThanOrEqual(3);
      expect(received().map((m) => m.offset)).toEqual(
        Array.from({ length: 300 }, (_, i) => String(i))
      );
    });

    it('buffers at most 1000 records between flushes, keeping the newest', async () => {
      vi.useFakeTimers();
      const { emit, id, received } = await subscribed();
      for (let i = 0; i < 1500; i += 1) emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), record(i));
      vi.advanceTimersByTime(100);
      const offsets = received().map((m) => m.offset);
      expect(offsets).toHaveLength(1000);
      expect(offsets[0]).toBe('500');
      expect(offsets.at(-1)).toBe('1499');
    });

    it('drops records still waiting for a flush when the log is cleared', async () => {
      vi.useFakeTimers();
      const { emit, id, received } = await subscribed();
      emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), record(1));
      useKafkaStore.getState().clearMessages(id);
      vi.advanceTimersByTime(100);
      expect(received()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('prunes paused partitions that a rebalance moved to another member', async () => {
      const { emit, id } = await subscribed();
      useKafkaStore.getState().updateConsumer(id, { pausedPartitions: ['orders:0', 'orders:1'] });
      emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_LAG, id), {
        lag: [{ topic: 'orders', offsets: ['4', '-1'] }],
      });
      expect(useKafkaStore.getState().connections[id]!.consumer.pausedPartitions).toEqual([
        'orders:0',
      ]);
      await kafkaManager.unsubscribe(id);
      expect(useKafkaStore.getState().connections[id]!.consumer.pausedPartitions).toBeUndefined();
    });

    it('holds records until the interval elapses and keeps manual-commit tokens', async () => {
      vi.useFakeTimers();
      const { emit, id, received } = await subscribed();
      emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), record(1, { commitToken: 'tok-1' }));
      vi.advanceTimersByTime(99);
      expect(received()).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(received()).toEqual([
        expect.objectContaining({ offset: '1', commitToken: 'tok-1', timestamp: 1_001 }),
      ]);
    });

    it('flushes buffered records before consumer-closed, error, and disconnect bookkeeping', async () => {
      vi.useFakeTimers();
      const { emit, id } = await subscribed();
      const values = () => useKafkaStore.getState().connections[id]!.messages.map((m) => m.value);

      emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), record(1));
      emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, id), {});
      expect(values().slice(-2)).toEqual(['v1', 'Consumer closed']);

      emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), record(2));
      emit(kafkaChannel(KAFKA_CHANNEL.ERROR, id), { scope: 'consumer', message: 'boom' });
      expect(values().slice(-2)).toEqual(['v2', '[consumer] boom']);

      emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), record(3));
      emit(kafkaChannel(KAFKA_CHANNEL.CLOSE, id), {});
      expect(values().slice(-2)).toEqual(['v3', 'Connection closed']);

      emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), record(4));
      await kafkaManager.disconnect(id);
      expect(values().at(-1)).toBe('v4');
      // No timer left armed after the drain.
      expect(vi.getTimerCount()).toBe(0);
    });
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
      membership: 'group',
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

  it('subscribes a default (browse) connection without any group or commit settings', async () => {
    const { kafka } = installElectronMock();
    const id = useKafkaStore.getState().createConnection();
    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    useKafkaStore.getState().updateConsumer(id, { lastN: 5, maxMessages: 20 });

    await kafkaManager.subscribe({
      connectionId: id,
      groupId: `restura-${id.slice(0, 8)}`,
      topics: ['orders'],
      fromBeginning: false,
    });

    const calls = kafka.subscribe.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const payload = calls.at(-1)?.[0];
    expect(payload).toMatchObject({
      membership: 'browse',
      mode: 'last-n',
      lastN: 5,
      maxMessages: 20,
      isolation: 'read-uncommitted',
    });
    for (const key of [
      'groupId',
      'commitPolicy',
      'groupProtocol',
      'fallbackMode',
      'lagIntervalMs',
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(useKafkaStore.getState().connections[id]!.messages.at(-1)?.value).toBe(
      'Browsing orders (read-only, no consumer group)'
    );
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
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({
        success: true,
        dryRun: true,
        offsets: [{ topic: 'orders', partition: 0, previous: '5', offset: '3' }],
        skipped: [{ topic: 'orders', partition: 1, reason: 'no-committed-offset' }],
      });
    kafka.deleteGroupOffsets
      .mockResolvedValueOnce({
        success: true,
        deleted: [{ topic: 'orders', partitions: [0] }],
        skipped: [{ topic: 'gone', partition: 0, reason: 'unknown-topic' }],
      })
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
    await expect(kafkaManager.resetGroupOffsets(reset)).resolves.toEqual({
      ok: true,
      offsets: [],
      skipped: [],
      dryRun: false,
    });
    await expect(kafkaManager.resetGroupOffsets(reset)).resolves.toEqual({
      ok: false,
      error: 'Reset offsets failed',
    });
    const shift = {
      connectionId: 'c',
      groupId: 'group',
      allTopics: true,
      to: 'shift' as const,
      shift: -2,
      dryRun: true,
    };
    await expect(kafkaManager.resetGroupOffsets(shift)).resolves.toEqual({
      ok: true,
      dryRun: true,
      offsets: [{ topic: 'orders', partition: 0, previous: '5', offset: '3' }],
      skipped: [{ topic: 'orders', partition: 1, reason: 'no-committed-offset' }],
    });
    expect(kafka.resetGroupOffsets).toHaveBeenLastCalledWith(shift);
    const del = { connectionId: 'c', groupId: 'group', topic: 'orders' };
    await expect(kafkaManager.deleteGroupOffsets(del)).resolves.toEqual({
      ok: true,
      deleted: [{ topic: 'orders', partitions: [0] }],
      skipped: [{ topic: 'gone', partition: 0, reason: 'unknown-topic' }],
    });
    await expect(kafkaManager.deleteGroupOffsets(del)).resolves.toEqual({
      ok: true,
      deleted: [],
      skipped: [],
    });
    await expect(kafkaManager.deleteGroupOffsets(del)).resolves.toEqual({
      ok: false,
      error: 'Delete offsets failed',
    });
    await expect(kafkaManager.deleteGroup('c', 'group')).resolves.toEqual({ ok: true });
    await expect(kafkaManager.deleteGroup('c', 'group')).resolves.toEqual({
      ok: false,
      error: 'Delete group failed',
    });
  });
});
