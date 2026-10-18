// @vitest-environment node

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBrokersSafe = vi.hoisted(() => vi.fn());
const mockRegistryUrlSafe = vi.hoisted(() => vi.fn());
const mockOnComplete = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  // fromId → undefined so emitToEntry falls back to the mocked emitTo, making
  // per-connection emissions observable without a real WebContents.
  webContents: { fromId: vi.fn(() => undefined) },
}));
// StreamRegistry and the handler emit through ipc-utils; mock it so emissions
// are observable and the real `electron` import inside ipc-utils never loads.
vi.mock('../ipc/ipc-utils', () => ({
  emitTo: mockEmitTo,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
// Broker/registry SSRF guards have their own suite (kafka-ssrf-guard.test.ts);
// here they are no-op spies so tests only assert the handler's wiring to them.
vi.mock('../security/kafka-broker-guard', () => ({
  assertKafkaBrokersSafe: mockBrokersSafe,
  assertRegistryUrlSafe: mockRegistryUrlSafe,
}));

import type * as KafkaLib from '@platformatic/kafka';
import { consoleSink, setLogSink } from '@shared/runtime/logger';
import { IPC } from '../../shared/channels';
import {
  __setKafkaForTests,
  kafkaRateLimiter,
  registerKafkaHandlerIPC,
  stopKafkaCleanup,
} from '../handlers/kafka-handler';
import { setExecutionPolicy } from '../security/execution-policy';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Fake @platformatic/kafka. NOT injectable via vi.mock — the handler loads the
// lib through a lazy bare `require('@platformatic/kafka')`, which vitest's
// ESM-level mocking does not intercept — so it goes in through the module's
// __setKafkaForTests seam instead. Producer/Admin record instances so tests can
// assert construction, send/close forwarding, and teardown symmetry.
class FakeProducer {
  static instances: FakeProducer[] = [];
  static metadataGates: Array<Promise<void>> = [];
  options: unknown;
  send = vi.fn(async (_options: { messages: Array<Record<string, unknown>>; acks?: number }) => ({
    offsets: [{ topic: 'orders', partition: 0, offset: 7n }],
  }));
  metadata = vi.fn(async () => {
    const gate = FakeProducer.metadataGates.shift();
    if (gate) await gate;
    return new Map();
  });
  close = vi.fn(async () => {});
  stream = new FakeProducerStream();
  transaction = new FakeTransaction();
  asStream = vi.fn(() => this.stream);
  beginTransaction = vi.fn(async () => this.transaction);
  constructor(options: unknown) {
    this.options = options;
    FakeProducer.instances.push(this);
  }
}
class FakeProducerStream extends EventEmitter {
  write = vi.fn(() => true);
  end = vi.fn(() => this.emit('finish'));
}
class FakeTransaction {
  id = 'txn-1';
  completed = false;
  send = vi.fn(async () => ({ offsets: [{ topic: 'orders', partition: 0, offset: 8n }] }));
  commit = vi.fn(async () => {
    this.completed = true;
  });
  abort = vi.fn(async () => {
    this.completed = true;
  });
}
class FakeAdmin {
  static instances: FakeAdmin[] = [];
  listTopics = vi.fn(async () => ['orders', 'payments']);
  createPartitions = vi.fn(async () => {});
  incrementalAlterConfigs = vi.fn(async () => {});
  deleteRecords = vi.fn(async () => [
    { name: 'orders', partitions: [{ partition: 0, lowWatermark: 42n }] },
  ]);
  createAcls = vi.fn(async () => {});
  describeAcls = vi.fn(async () => []);
  deleteAcls = vi.fn(async () => []);
  describeClientQuotas = vi.fn(async () => []);
  alterClientQuotas = vi.fn(async () => []);
  describeGroups = vi.fn(
    async () => new Map([['g', { id: 'g', state: 'EMPTY', members: new Map() }]])
  );
  listConsumerGroupOffsets = vi.fn(async () => [
    {
      groupId: 'g',
      topics: [{ name: 'orders', partitions: [{ partitionIndex: 0, committedOffset: 5n }] }],
    },
  ]);
  listOffsets = vi.fn(
    async ({
      topics,
    }: {
      topics: { name: string; partitions: { partitionIndex: number; timestamp: bigint }[] }[];
    }) =>
      topics.map((t) => ({
        name: t.name,
        partitions: t.partitions.map((p) => ({
          partitionIndex: p.partitionIndex,
          offset: p.timestamp === -2n ? 0n : 9n,
        })),
      }))
  );
  alterConsumerGroupOffsets = vi.fn(async () => {});
  deleteConsumerGroupOffsets = vi.fn(async () => [{ name: 'orders', partitionIndexes: [0] }]);
  metadata = vi.fn(async () => ({
    id: 'cluster-1',
    controllerId: 1,
    brokers: new Map([[1, { host: 'broker', port: 9092, rack: null }]]),
    topics: new Map([['orders', { partitionsCount: 3 }]]),
  }));
  close = vi.fn(async () => {});
  constructor(_options: unknown) {
    FakeAdmin.instances.push(this);
  }
}
class FakeConsumer extends EventEmitter {
  static instances: FakeConsumer[] = [];
  options: unknown;
  stream = new FakeConsumerStream();
  /** Every stream handed out by consume(); [0] is the subscribe-time stream. */
  streams: FakeConsumerStream[] = [];
  // The first consume() is the subscription; later ones are seek/resume repositions.
  consume = vi.fn(async (_options?: unknown) => {
    const next = this.streams.length === 0 ? this.stream : new FakeConsumerStream();
    this.streams.push(next);
    return next;
  });
  close = vi.fn(async () => {});
  startLagMonitoring = vi.fn();
  /** Per-partition [log-start, log-end] used by seek clamping. */
  watermarks = { earliest: 10n, latest: 100n };
  listOffsets = vi.fn(async (options: { topics: string[]; timestamp: bigint }) => {
    const value = options.timestamp === -2n ? this.watermarks.earliest : this.watermarks.latest;
    return new Map(options.topics.map((topic) => [topic, [value, value, value]]));
  });
  listOffsetsWithTimestamps = vi.fn(
    async (_options: unknown) =>
      new Map([['orders', new Map([[1, { offset: 42n, timestamp: 5n }]])]])
  );
  constructor(options: unknown) {
    super();
    this.options = options;
    FakeConsumer.instances.push(this);
  }
}
class FakeConsumerStream extends EventEmitter {
  pause = vi.fn(() => this);
  resume = vi.fn(() => this);
  close = vi.fn(async () => {
    this.emit('close');
  });
  /** Next-fetch position per `topic:partition`, as the native stream tracks it. */
  offsetsToFetch = new Map<string, bigint>();
  /** Records fetched but not yet handed to a listener (drained by read()). */
  buffered: unknown[] = [];
  read = vi.fn(() => {
    const next = this.buffered.shift();
    if (next === undefined) return null;
    this.emit('data', next);
    return next;
  });
}
const fakeKafkaLib = {
  Producer: FakeProducer,
  Admin: FakeAdmin,
  Consumer: FakeConsumer,
  MessagesStreamModes: {
    LATEST: 'LATEST',
    EARLIEST: 'EARLIEST',
    COMMITTED: 'COMMITTED',
    MANUAL: 'MANUAL',
  },
  MessagesStreamFallbackModes: { LATEST: 'LATEST', EARLIEST: 'EARLIEST', FAIL: 'FAIL' },
  GroupProtocols: { CLASSIC: 'classic', CONSUMER: 'consumer' },
  ListOffsetTimestamps: { EARLIEST: -2n, LATEST: -1n },
  ConfigResourceTypes: { TOPIC: 2 },
  IncrementalAlterConfigOperationTypes: { SET: 0, DELETE: 1, APPEND: 2, SUBTRACT: 3 },
  ClientQuotaMatchTypes: { EXACT: 0, DEFAULT: 1, ANY: 2 },
} as unknown as typeof KafkaLib;

type IpcHandler = (
  e: unknown,
  p: unknown
) => Promise<{ success: boolean; error?: string } & Record<string, unknown>>;

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  return call?.[1] as IpcHandler;
}

const TRUSTED_URL = 'file:///app/dist/web/index.html';
let nextSenderId = 2000;

/**
 * Fake IpcMainInvokeEvent. Fresh sender id per event so the real (module-level)
 * kafkaRateLimiter and bindRendererCleanup's per-id dedupe can't leak across tests.
 */
function makeEvent(frameUrl = TRUSTED_URL) {
  const id = nextSenderId++;
  const destroyedListeners: Array<() => void> = [];
  return {
    senderId: id,
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        once: (evt: string, cb: () => void) => {
          if (evt === 'destroyed') destroyedListeners.push(cb);
        },
      },
      senderFrame: { url: frameUrl, parent: null },
    },
    destroy: () => destroyedListeners.splice(0).forEach((cb) => cb()),
  };
}

const validConnect = (connectionId: string, extra: Record<string, unknown> = {}) => ({
  connectionId,
  clientId: 'restura-test',
  bootstrapBrokers: ['broker.example.com:9092'],
  auth: { securityProtocol: 'PLAINTEXT' as const },
  ...extra,
});

const validProduce = (connectionId: string, extra: Record<string, unknown> = {}) => ({
  connectionId,
  record: {
    topic: 'orders',
    value: { encoding: 'utf8', data: 'hello' },
    ...('record' in extra ? (extra.record as object) : {}),
  },
  acks: 1,
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'record')),
});

describe('kafka-handler', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockBrokersSafe.mockClear();
    mockRegistryUrlSafe.mockClear();
    mockOnComplete.mockClear();
    FakeProducer.instances.length = 0;
    FakeProducer.metadataGates.length = 0;
    FakeAdmin.instances.length = 0;
    FakeConsumer.instances.length = 0;
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: true },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    __setKafkaForTests(fakeKafkaLib);
    registerKafkaHandlerIPC(mockOnComplete);
  });
  afterEach(async () => {
    await stopKafkaCleanup();
    __setKafkaForTests(undefined);
    setLogSink(consoleSink);
  });

  it('registers exactly the IPC.kafka channels', () => {
    const channels = mockHandle.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(Object.values(IPC.kafka).sort());
  });

  it('rejects kafka:connect from an untrusted frame before doing any work', async () => {
    const { event } = makeEvent('https://attacker.example/');
    await expect(handlerFor(IPC.kafka.connect)(event, validConnect('c1'))).rejects.toThrow(
      /untrusted frame/
    );
    expect(FakeProducer.instances).toHaveLength(0);
    expect(mockBrokersSafe).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload via the Zod schema (malformed broker)', async () => {
    const { event } = makeEvent();
    await expect(
      handlerFor(IPC.kafka.connect)(event, validConnect('c1', { bootstrapBrokers: ['no-port'] }))
    ).rejects.toThrow(/Invalid IPC payload for kafka:connect/);
    expect(FakeProducer.instances).toHaveLength(0);
  });

  it('rejects a connect once the sender has drained its rate-limit bucket', async () => {
    const { event, senderId } = makeEvent();
    try {
      let guard = 0;
      while (kafkaRateLimiter.check(senderId) && guard++ < 1000) {
        /* drain the sender's bucket */
      }
      const res = await handlerFor(IPC.kafka.connect)(event, validConnect('c-rl'));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Rate limit/);
      expect(FakeProducer.instances).toHaveLength(0);
    } finally {
      kafkaRateLimiter.dispose(senderId);
    }
  });

  it('runs the broker SSRF guard at connect and constructs a producer on success', async () => {
    const { event, senderId } = makeEvent();
    const res = await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    expect(res).toEqual({ success: true });
    expect(mockBrokersSafe).toHaveBeenCalledWith(['broker.example.com:9092'], {
      allowLocalhost: true,
      allowPrivateIPs: true,
    });
    expect(FakeProducer.instances).toHaveLength(1);
    expect(FakeProducer.instances[0]!.metadata).toHaveBeenCalledWith({
      autocreateTopics: false,
      forceUpdate: true,
    });
    expect(mockEmitTo).toHaveBeenCalledWith(
      senderId,
      'kafka:connected:c1',
      expect.objectContaining({ timestamp: expect.any(Number) })
    );
  });

  it('logs a successful connection without broker addresses or credentials', async () => {
    const records: Array<{
      level: string;
      scope: string;
      message: string;
      fields: Record<string, unknown>;
    }> = [];
    setLogSink((record) => records.push(record));
    const { event } = makeEvent();

    await expect(handlerFor(IPC.kafka.connect)(event, validConnect('c-log'))).resolves.toEqual({
      success: true,
    });

    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'info',
        scope: 'kafka',
        message: 'connected',
        fields: { connectionId: 'c-log', idempotent: false, schemaRegistry: false },
      })
    );
    expect(JSON.stringify(records)).not.toContain('broker.example.com');
    expect(mockOnComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'CONNECT',
        url: 'kafka://connection/c-log',
        protocol: 'kafka',
        requestId: 'c-log',
      })
    );
    expect(JSON.stringify(mockOnComplete.mock.calls)).not.toContain('broker.example.com');
  });

  it('maps a broker-guard rejection to { success: false } without constructing a producer', async () => {
    mockBrokersSafe.mockImplementationOnce(() => {
      throw new Error('Broker address not allowed');
    });
    const { event } = makeEvent();
    const res = await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    expect(res).toEqual({ success: false, error: 'Broker address not allowed' });
    expect(FakeProducer.instances).toHaveLength(0);
  });

  it('kafka:produce forwards to producer.send and reports Not connected for unknown ids', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    const producer = FakeProducer.instances[0]!;

    const ok = await handlerFor(IPC.kafka.produce)(event, validProduce('c1'));
    expect(ok.success).toBe(true);
    expect(ok.ack).toEqual({
      topic: 'orders',
      partition: 0,
      offset: '7',
      timestamp: expect.any(Number),
    });
    expect(producer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        acks: 1,
        messages: [expect.objectContaining({ topic: 'orders', value: Buffer.from('hello') })],
      })
    );

    const missing = await handlerFor(IPC.kafka.produce)(event, validProduce('nope'));
    expect(missing).toEqual({ success: false, error: 'Not connected' });
  });

  it('publishes a Base64 payload as its exact raw bytes and rejects malformed Base64', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    const producer = FakeProducer.instances[0]!;

    await expect(
      handlerFor(IPC.kafka.produce)(
        event,
        validProduce('c1', { record: { value: { encoding: 'base64', data: '/4AB' } } })
      )
    ).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(producer.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ value: Buffer.from([0xff, 0x80, 0x01]) })],
      })
    );

    await expect(
      handlerFor(IPC.kafka.produce)(
        event,
        validProduce('c1', { record: { value: { encoding: 'base64', data: 'not base64' } } })
      )
    ).rejects.toThrow('Invalid IPC payload');
    expect(producer.send).toHaveBeenCalledTimes(1);
  });

  it('an idempotent connection forces acks=-1 on produce regardless of the payload acks', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1', { idempotent: true }));
    await handlerFor(IPC.kafka.produce)(event, validProduce('c1', { acks: 0 }));
    expect(FakeProducer.instances[0]!.send).toHaveBeenCalledWith(
      expect.objectContaining({ acks: -1 })
    );
  });

  it('keeps empty bytes, tombstones, binary headers, and timestamps distinct', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('typed'));
    const producer = FakeProducer.instances[0]!;
    await handlerFor(IPC.kafka.produce)(
      event,
      validProduce('typed', {
        record: {
          topic: 'orders',
          value: { encoding: 'utf8', data: '' },
          headers: [
            {
              key: { encoding: 'base64', data: '/w==' },
              value: { encoding: 'base64', data: 'AA==' },
            },
          ],
          timestamp: '1722222222000',
        },
      })
    );
    expect(producer.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            value: Buffer.alloc(0),
            timestamp: 1722222222000n,
            headers: new Map([[Buffer.from([0xff]), Buffer.from([0])]]),
          }),
        ],
      })
    );

    await handlerFor(IPC.kafka.produce)(
      event,
      validProduce('typed', {
        record: { topic: 'orders', value: { encoding: 'null' } },
      })
    );
    expect(producer.send.mock.calls.at(-1)?.[0].messages[0]).not.toHaveProperty('value');
  });

  it('supports interactive batches, producer streams, and transaction sessions', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(
      event,
      validConnect('sessions', { idempotent: true, transactionalId: 'restura-txn' })
    );
    const producer = FakeProducer.instances[0]!;
    const record = { topic: 'orders', value: { encoding: 'utf8', data: 'hello' } };

    await expect(
      handlerFor(IPC.kafka.produceBatch)(event, {
        connectionId: 'sessions',
        records: [record, record],
        acks: -1,
      })
    ).resolves.toMatchObject({ success: true, acks: expect.any(Array) });
    expect(producer.send.mock.calls.at(-1)?.[0].messages).toHaveLength(2);

    await expect(
      handlerFor(IPC.kafka.openProducerStream)(event, {
        connectionId: 'sessions',
        acks: -1,
        batchSize: 10,
      })
    ).resolves.toEqual({ success: true });
    await handlerFor(IPC.kafka.writeProducerStream)(event, {
      connectionId: 'sessions',
      record,
    });
    expect(producer.stream.write).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'orders', value: Buffer.from('hello') })
    );
    await handlerFor(IPC.kafka.closeProducerStream)(event, { connectionId: 'sessions' });

    await expect(
      handlerFor(IPC.kafka.beginTransaction)(event, { connectionId: 'sessions' })
    ).resolves.toEqual({ success: true, transactionId: 'txn-1' });
    await handlerFor(IPC.kafka.produce)(event, validProduce('sessions'));
    expect(producer.transaction.send).toHaveBeenCalled();
    await handlerFor(IPC.kafka.endTransaction)(event, {
      connectionId: 'sessions',
      action: 'commit',
    });
    expect(producer.transaction.commit).toHaveBeenCalled();
  });

  it('uses native committed consumption, manual commits, lag monitoring, and pause/resume', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('consumer'));
    await expect(
      handlerFor(IPC.kafka.subscribe)(event, {
        connectionId: 'consumer',
        groupId: 'g',
        topics: ['orders'],
        mode: 'committed',
        fallbackMode: 'latest',
        commitPolicy: 'manual',
        isolation: 'read-committed',
        groupProtocol: 'consumer',
        lagIntervalMs: 1000,
      })
    ).resolves.toEqual({ success: true });
    const consumer = FakeConsumer.instances[0]!;
    expect(consumer.consume).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'COMMITTED', fallbackMode: 'LATEST' })
    );
    expect(consumer.startLagMonitoring).toHaveBeenCalledWith({ topics: ['orders'] }, 1000);

    await handlerFor(IPC.kafka.pauseConsumer)(event, { connectionId: 'consumer' });
    await handlerFor(IPC.kafka.resumeConsumer)(event, { connectionId: 'consumer' });
    expect(consumer.stream.pause).toHaveBeenCalled();
    expect(consumer.stream.resume).toHaveBeenCalled();

    const commit = vi.fn(async () => {});
    consumer.stream.emit('data', {
      topic: 'orders',
      partition: 0,
      offset: 4n,
      key: Buffer.from('k'),
      value: Buffer.from('v'),
      headers: new Map(),
      timestamp: 1n,
      metadata: {},
      commit,
    });
    await vi.waitFor(() => {
      expect(mockEmitTo).toHaveBeenCalledWith(
        expect.any(Number),
        'kafka:message:consumer',
        expect.objectContaining({ commitToken: expect.any(String) })
      );
    });
    consumer.stream.emit('data', {
      topic: 'orders',
      partition: 0,
      offset: 5n,
      key: undefined,
      value: undefined,
      headers: new Map(),
      timestamp: 2n,
      metadata: {},
      commit: vi.fn(async () => {}),
    });
    await vi.waitFor(() => {
      expect(mockEmitTo).toHaveBeenCalledWith(
        expect.any(Number),
        'kafka:message:consumer',
        expect.objectContaining({ offset: '5', tombstone: true, value: '' })
      );
    });
    const payload = mockEmitTo.mock.calls.find((call) => call[1] === 'kafka:message:consumer')?.[2];
    await handlerFor(IPC.kafka.commitMessage)(event, {
      connectionId: 'consumer',
      commitToken: payload.commitToken,
    });
    expect(commit).toHaveBeenCalled();
  });

  describe('emit-queue backpressure (#938)', () => {
    const record = (offset: number, commit = vi.fn(async () => {})) => ({
      topic: 'orders',
      partition: 0,
      offset: BigInt(offset),
      key: undefined,
      value: Buffer.from(`v${offset}`),
      headers: new Map(),
      timestamp: BigInt(offset),
      metadata: {},
      commit,
    });

    async function subscribed(connectionId: string, commitPolicy: 'auto' | 'manual' = 'auto') {
      const { event } = makeEvent();
      await handlerFor(IPC.kafka.connect)(event, validConnect(connectionId));
      await handlerFor(IPC.kafka.subscribe)(event, {
        connectionId,
        groupId: 'g',
        topics: ['orders'],
        mode: 'committed',
        fallbackMode: 'latest',
        commitPolicy,
        isolation: 'read-uncommitted',
        groupProtocol: 'classic',
      });
      const stream = FakeConsumer.instances[0]!.stream;
      stream.pause.mockClear();
      stream.resume.mockClear();
      const delivered = () =>
        mockEmitTo.mock.calls.filter((c) => c[1] === `kafka:message:${connectionId}`);
      return { event, stream, delivered };
    }

    it('pauses the stream when the queue exceeds 500 and resumes once it drains', async () => {
      const { stream, delivered } = await subscribed('bp');
      for (let i = 0; i < 500; i += 1) stream.emit('data', record(i));
      expect(stream.pause).not.toHaveBeenCalled();
      stream.emit('data', record(500));
      expect(stream.pause).toHaveBeenCalledTimes(1);
      expect(stream.resume).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(delivered()).toHaveLength(501));
      expect(stream.resume).toHaveBeenCalledTimes(1);
      // Ordered delivery survives the pause/resume cycle.
      expect(delivered().map((c) => c[2].offset)).toEqual(
        Array.from({ length: 501 }, (_, i) => String(i))
      );
    });

    it('a backpressure drain does not resume a consumer the user paused', async () => {
      const { event, stream, delivered } = await subscribed('bp-user');
      for (let i = 0; i < 501; i += 1) stream.emit('data', record(i));
      expect(stream.pause).toHaveBeenCalledTimes(1);
      await expect(
        handlerFor(IPC.kafka.pauseConsumer)(event, { connectionId: 'bp-user' })
      ).resolves.toEqual({ success: true });

      await vi.waitFor(() => expect(delivered()).toHaveLength(501));
      expect(stream.resume).not.toHaveBeenCalled();

      await handlerFor(IPC.kafka.resumeConsumer)(event, { connectionId: 'bp-user' });
      expect(stream.resume).toHaveBeenCalledTimes(1);
    });

    it('keeps manual-commit tokens valid for records delivered after a backpressure pause', async () => {
      const { event, stream, delivered } = await subscribed('bp-commit', 'manual');
      const commits = Array.from({ length: 502 }, () => vi.fn(async () => {}));
      for (let i = 0; i < 502; i += 1) stream.emit('data', record(i, commits[i]));
      expect(stream.pause).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(delivered()).toHaveLength(502));

      const last = delivered().at(-1)![2] as { commitToken: string; offset: string };
      expect(last.offset).toBe('501');
      await expect(
        handlerFor(IPC.kafka.commitMessage)(event, {
          connectionId: 'bp-commit',
          commitToken: last.commitToken,
        })
      ).resolves.toEqual({ success: true });
      expect(commits[501]).toHaveBeenCalledTimes(1);
    });

    it('rejects pause/resume when no consumer is subscribed', async () => {
      const { event } = makeEvent();
      await handlerFor(IPC.kafka.connect)(event, validConnect('idle'));
      await expect(
        handlerFor(IPC.kafka.pauseConsumer)(event, { connectionId: 'idle' })
      ).resolves.toEqual({ success: false, error: 'No consumer is active.' });
      await expect(
        handlerFor(IPC.kafka.resumeConsumer)(event, { connectionId: 'idle' })
      ).resolves.toEqual({ success: false, error: 'No consumer is active.' });
    });
  });

  describe('per-partition pause/resume and live seek (#942)', () => {
    const record = (partition: number, offset: number, commit = vi.fn(async () => {})) => ({
      topic: 'orders',
      partition,
      offset: BigInt(offset),
      key: undefined,
      value: Buffer.from(`p${partition}-${offset}`),
      headers: new Map(),
      timestamp: BigInt(offset),
      metadata: {},
      commit,
    });

    async function live(connectionId: string, commitPolicy: 'auto' | 'manual' = 'auto') {
      const { event } = makeEvent();
      await handlerFor(IPC.kafka.connect)(event, validConnect(connectionId));
      await handlerFor(IPC.kafka.subscribe)(event, {
        connectionId,
        groupId: 'g',
        topics: ['orders'],
        mode: 'committed',
        fallbackMode: 'latest',
        commitPolicy,
        isolation: 'read-uncommitted',
        groupProtocol: 'classic',
      });
      const consumer = FakeConsumer.instances[0]!;
      const stream = consumer.stream;
      stream.offsetsToFetch.set('orders:0', 7n).set('orders:1', 20n);
      const delivered = () =>
        mockEmitTo.mock.calls
          .filter((c) => c[1] === `kafka:message:${connectionId}`)
          .map((c) => c[2] as { partition: number; offset: string; commitToken?: string });
      const call = (channel: string, payload: Record<string, unknown>) =>
        handlerFor(channel)(event, { connectionId, ...payload });
      return { event, consumer, stream, delivered, call };
    }

    it('withholds a paused partition while the others keep flowing', async () => {
      const { stream, delivered, call } = await live('pp');
      await expect(
        call(IPC.kafka.pausePartitions, { partitions: [{ topic: 'orders', partition: 1 }] })
      ).resolves.toEqual({
        success: true,
        pausedPartitions: [{ topic: 'orders', partition: 1 }],
      });
      stream.emit('data', record(0, 7));
      stream.emit('data', record(1, 20));
      stream.emit('data', record(0, 8));
      await vi.waitFor(() => expect(delivered()).toHaveLength(2));
      expect(delivered().map((m) => `${m.partition}@${m.offset}`)).toEqual(['0@7', '0@8']);
      expect(stream.pause).not.toHaveBeenCalled();
    });

    it('resumes a partition from its first withheld record via a MANUAL-mode stream swap', async () => {
      const { consumer, stream, delivered, call } = await live('pr');
      await call(IPC.kafka.pausePartitions, { partitions: [{ topic: 'orders', partition: 1 }] });
      stream.emit('data', record(1, 20));
      stream.emit('data', record(1, 21));
      stream.offsetsToFetch.set('orders:1', 22n);
      // Already fetched for a running partition: must be delivered, not lost, by the swap.
      stream.buffered.push(record(0, 7));
      stream.offsetsToFetch.set('orders:0', 8n);

      await expect(
        call(IPC.kafka.resumePartitions, { partitions: [{ topic: 'orders', partition: 1 }] })
      ).resolves.toEqual({ success: true, pausedPartitions: [] });

      expect(consumer.consume).toHaveBeenCalledTimes(2);
      expect(consumer.consume).toHaveBeenLastCalledWith({
        topics: ['orders'],
        mode: 'MANUAL',
        offsets: [
          { topic: 'orders', partition: 0, offset: 8n },
          { topic: 'orders', partition: 1, offset: 20n },
        ],
      });
      // The replacement was opened before the old stream closed (no group rejoin).
      const next = consumer.streams[1]!;
      expect(consumer.consume.mock.invocationCallOrder[1]!).toBeLessThan(
        stream.close.mock.invocationCallOrder[0]!
      );
      expect(stream.close).toHaveBeenCalledTimes(1);
      // Closing the swapped-out stream is not reported as the consumer closing.
      expect(mockEmitTo).not.toHaveBeenCalledWith(
        expect.any(Number),
        'kafka:consumer-closed:pr',
        expect.anything()
      );

      next.emit('data', record(1, 20));
      stream.emit('data', record(0, 99)); // late record from the retired stream: ignored
      await vi.waitFor(() => expect(delivered()).toHaveLength(2));
      expect(delivered().map((m) => `${m.partition}@${m.offset}`)).toEqual(['0@7', '1@20']);
    });

    it('withholds (not duplicates) paused-partition records drained during a resume', async () => {
      const { consumer, stream, delivered, call } = await live('pr-drain');
      await call(IPC.kafka.pausePartitions, { partitions: [{ topic: 'orders', partition: 1 }] });
      // Fetched but still buffered when the resume arrives; the next fetch would start at 22.
      stream.buffered.push(record(1, 20), record(1, 21));
      stream.offsetsToFetch.set('orders:1', 22n);

      await call(IPC.kafka.resumePartitions, { partitions: [{ topic: 'orders', partition: 1 }] });
      expect(consumer.consume).toHaveBeenLastCalledWith(
        expect.objectContaining({
          offsets: expect.arrayContaining([{ topic: 'orders', partition: 1, offset: 20n }]),
        })
      );
      await Promise.resolve();
      expect(delivered()).toHaveLength(0);
    });

    it('ignores resume requests for partitions that are not paused', async () => {
      const { consumer, stream, call } = await live('pr-noop');
      await expect(
        call(IPC.kafka.resumePartitions, { partitions: [{ topic: 'orders', partition: 3 }] })
      ).resolves.toEqual({ success: true, pausedPartitions: [] });
      expect(stream.pause).not.toHaveBeenCalled();
      expect(consumer.consume).toHaveBeenCalledTimes(1);
    });

    it('abandons a swap when the consumer is unsubscribed mid-seek', async () => {
      const { event, consumer, stream, call } = await live('seek-race');
      const gate = deferred<void>();
      const replacement = new FakeConsumerStream();
      consumer.consume.mockImplementationOnce(async () => {
        await gate.promise;
        consumer.streams.push(replacement);
        return replacement;
      });
      const seek = call(IPC.kafka.seekConsumer, {
        topic: 'orders',
        partition: 0,
        target: { kind: 'offset', offset: '50' },
      });
      await vi.waitFor(() => expect(consumer.consume).toHaveBeenCalledTimes(2));
      await handlerFor(IPC.kafka.unsubscribe)(event, { connectionId: 'seek-race' });
      gate.resolve();
      await expect(seek).resolves.toEqual({
        success: false,
        error: 'The consumer was closed while repositioning.',
      });
      expect(replacement.close).toHaveBeenCalledTimes(1);
      expect(stream.close).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent seeks so streams never swap in parallel', async () => {
      const { consumer, call } = await live('seek-serial');
      const gate = deferred<void>();
      consumer.consume.mockImplementationOnce(async () => {
        await gate.promise;
        const next = new FakeConsumerStream();
        consumer.streams.push(next);
        return next;
      });
      const seek = (offset: string) =>
        call(IPC.kafka.seekConsumer, {
          topic: 'orders',
          partition: 0,
          target: { kind: 'offset', offset },
        });
      const first = seek('50');
      const second = seek('60');
      await vi.waitFor(() => expect(consumer.consume).toHaveBeenCalledTimes(2));
      await Promise.resolve();
      expect(consumer.consume).toHaveBeenCalledTimes(2);
      gate.resolve();
      await expect(first).resolves.toEqual({ success: true, offset: '50' });
      await expect(second).resolves.toEqual({ success: true, offset: '60' });
      expect(consumer.consume).toHaveBeenCalledTimes(3);
      // The second swap retired the first replacement, not the original stream again.
      expect(consumer.streams[1]!.close).toHaveBeenCalledTimes(1);
    });

    it('resuming a partition that withheld nothing needs no stream swap', async () => {
      const { consumer, call } = await live('pr-idle');
      await call(IPC.kafka.pausePartitions, { partitions: [{ topic: 'orders', partition: 0 }] });
      await expect(
        call(IPC.kafka.resumePartitions, {
          partitions: [
            { topic: 'orders', partition: 0 },
            { topic: 'orders', partition: 5 },
          ],
        })
      ).resolves.toEqual({ success: true, pausedPartitions: [] });
      expect(consumer.consume).toHaveBeenCalledTimes(1);
    });

    it('keeps a partition paused (with its rewind point) when the swap fails', async () => {
      const { consumer, stream, call } = await live('pr-fail');
      await call(IPC.kafka.pausePartitions, { partitions: [{ topic: 'orders', partition: 1 }] });
      stream.emit('data', record(1, 20));
      consumer.consume.mockRejectedValueOnce(new Error('broker down'));
      stream.resume.mockClear();

      await expect(
        call(IPC.kafka.resumePartitions, { partitions: [{ topic: 'orders', partition: 1 }] })
      ).resolves.toEqual({ success: false, error: 'broker down' });
      // The old stream is handed back to the flow controller and keeps running.
      expect(stream.resume).toHaveBeenCalledTimes(1);
      expect(stream.close).not.toHaveBeenCalled();

      await call(IPC.kafka.resumePartitions, { partitions: [{ topic: 'orders', partition: 1 }] });
      expect(consumer.consume).toHaveBeenLastCalledWith(
        expect.objectContaining({
          offsets: expect.arrayContaining([{ topic: 'orders', partition: 1, offset: 20n }]),
        })
      );
    });

    it('seeks a running partition to an offset, clamped to the log range', async () => {
      const { consumer, call } = await live('seek');
      await expect(
        call(IPC.kafka.seekConsumer, {
          topic: 'orders',
          partition: 1,
          target: { kind: 'offset', offset: '55' },
        })
      ).resolves.toEqual({ success: true, offset: '55' });
      expect(consumer.consume).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mode: 'MANUAL',
          offsets: [
            { topic: 'orders', partition: 0, offset: 7n },
            { topic: 'orders', partition: 1, offset: 55n },
          ],
        })
      );
      expect(consumer.listOffsets).toHaveBeenCalledWith(
        expect.objectContaining({ topics: ['orders'], partitions: { orders: [1] } })
      );

      await expect(
        call(IPC.kafka.seekConsumer, {
          topic: 'orders',
          partition: 1,
          target: { kind: 'offset', offset: '3' },
        })
      ).resolves.toEqual({ success: true, offset: '10' });
      await expect(
        call(IPC.kafka.seekConsumer, {
          topic: 'orders',
          partition: 1,
          target: { kind: 'offset', offset: '9000' },
        })
      ).resolves.toEqual({ success: true, offset: '100' });
      expect(consumer.consume).toHaveBeenCalledTimes(4);
    });

    it('seeks by timestamp, landing at the log end when no record is that recent', async () => {
      const { consumer, call } = await live('seek-ts');
      await expect(
        call(IPC.kafka.seekConsumer, {
          topic: 'orders',
          partition: 1,
          target: { kind: 'timestamp', timestamp: '1700000000000' },
        })
      ).resolves.toEqual({ success: true, offset: '42' });
      expect(consumer.listOffsetsWithTimestamps).toHaveBeenCalledWith({
        topics: ['orders'],
        partitions: { orders: [1] },
        timestamp: 1_700_000_000_000n,
      });

      consumer.listOffsetsWithTimestamps.mockResolvedValueOnce(
        new Map([['orders', new Map([[1, { offset: -1n, timestamp: -1n }]])]])
      );
      await expect(
        call(IPC.kafka.seekConsumer, {
          topic: 'orders',
          partition: 1,
          target: { kind: 'timestamp', timestamp: '1900000000000' },
        })
      ).resolves.toEqual({ success: true, offset: '100' });
    });

    it('seeking a paused partition only moves its resume point', async () => {
      const { consumer, stream, call } = await live('seek-paused');
      await call(IPC.kafka.pausePartitions, { partitions: [{ topic: 'orders', partition: 1 }] });
      stream.emit('data', record(1, 20));
      await expect(
        call(IPC.kafka.seekConsumer, {
          topic: 'orders',
          partition: 1,
          target: { kind: 'offset', offset: '60' },
        })
      ).resolves.toEqual({ success: true, offset: '60' });
      expect(consumer.consume).toHaveBeenCalledTimes(1);

      await call(IPC.kafka.resumePartitions, { partitions: [{ topic: 'orders', partition: 1 }] });
      expect(consumer.consume).toHaveBeenLastCalledWith(
        expect.objectContaining({
          offsets: expect.arrayContaining([{ topic: 'orders', partition: 1, offset: 60n }]),
        })
      );
    });

    it('carries a user pause and manual-commit tokens across a seek', async () => {
      const { consumer, stream, delivered, call } = await live('seek-user', 'manual');
      const commit = vi.fn(async () => {});
      stream.emit('data', record(0, 7, commit));
      await vi.waitFor(() => expect(delivered()).toHaveLength(1));
      await call(IPC.kafka.pauseConsumer, {});

      await call(IPC.kafka.seekConsumer, {
        topic: 'orders',
        partition: 0,
        target: { kind: 'offset', offset: '50' },
      });
      const next = consumer.streams[1]!;
      expect(next.pause).toHaveBeenCalledTimes(1);
      expect(next.resume).not.toHaveBeenCalled();

      await expect(
        call(IPC.kafka.commitMessage, { commitToken: delivered()[0]!.commitToken })
      ).resolves.toEqual({ success: true });
      expect(commit).toHaveBeenCalledTimes(1);

      await call(IPC.kafka.resumeConsumer, {});
      expect(next.resume).toHaveBeenCalledTimes(1);
    });

    it('rejects controls without a consumer or for topics outside the subscription', async () => {
      const { event } = makeEvent();
      await handlerFor(IPC.kafka.connect)(event, validConnect('no-consumer'));
      const partitions = [{ topic: 'orders', partition: 0 }];
      for (const channel of [IPC.kafka.pausePartitions, IPC.kafka.resumePartitions]) {
        await expect(
          handlerFor(channel)(event, { connectionId: 'no-consumer', partitions })
        ).resolves.toEqual({ success: false, error: 'No consumer is active.' });
      }
      await expect(
        handlerFor(IPC.kafka.seekConsumer)(event, {
          connectionId: 'no-consumer',
          topic: 'orders',
          partition: 0,
          target: { kind: 'offset', offset: '1' },
        })
      ).resolves.toEqual({ success: false, error: 'No consumer is active.' });

      const { call } = await live('other-topic');
      const notSubscribed = {
        success: false,
        error: 'Topic "payments" is not part of this subscription.',
      };
      await expect(
        call(IPC.kafka.pausePartitions, { partitions: [{ topic: 'payments', partition: 0 }] })
      ).resolves.toEqual(notSubscribed);
      await expect(
        call(IPC.kafka.seekConsumer, {
          topic: 'payments',
          partition: 0,
          target: { kind: 'offset', offset: '1' },
        })
      ).resolves.toEqual(notSubscribed);
    });

    it('reports a seek failure (e.g. unknown partition) without swapping streams', async () => {
      const { consumer, call } = await live('seek-missing');
      consumer.listOffsets.mockResolvedValueOnce(new Map([['orders', []]]));
      await expect(
        call(IPC.kafka.seekConsumer, {
          topic: 'orders',
          partition: 9,
          target: { kind: 'offset', offset: '1' },
        })
      ).resolves.toEqual({
        success: false,
        error: 'Partition 9 of "orders" was not found.',
      });
      expect(consumer.consume).toHaveBeenCalledTimes(1);
    });

    it('validates payloads and rate-limits the partition and seek channels', async () => {
      const { event } = makeEvent();
      await expect(
        handlerFor(IPC.kafka.seekConsumer)(event, {
          connectionId: 'x',
          topic: 'orders',
          partition: 0,
          target: { kind: 'offset', offset: '-1' },
        })
      ).rejects.toThrow(/Invalid IPC payload for kafka:consumer-seek/);
      await expect(
        handlerFor(IPC.kafka.pausePartitions)(event, { connectionId: 'x', partitions: [] })
      ).rejects.toThrow(/Invalid IPC payload for kafka:consumer-pause-partitions/);

      const limited = makeEvent();
      for (let i = 0; i < 120; i += 1) kafkaRateLimiter.check(limited.senderId);
      await expect(
        handlerFor(IPC.kafka.resumePartitions)(limited.event, {
          connectionId: 'x',
          partitions: [{ topic: 'orders', partition: 0 }],
        })
      ).rejects.toThrow('Rate limit exceeded');
    });
  });

  it('emits consumed messages when the native message omits headers', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('headerless'));
    await handlerFor(IPC.kafka.subscribe)(event, {
      connectionId: 'headerless',
      groupId: 'g',
      topics: ['orders'],
      mode: 'committed',
      fallbackMode: 'latest',
      commitPolicy: 'auto',
      isolation: 'read-uncommitted',
      groupProtocol: 'classic',
    });

    FakeConsumer.instances[0]!.stream.emit('data', {
      topic: 'orders',
      partition: 0,
      offset: 1n,
      key: undefined,
      value: Buffer.from('headerless'),
      timestamp: 1n,
      metadata: {},
      commit: vi.fn(async () => {}),
    });

    await vi.waitFor(() => {
      expect(mockEmitTo).toHaveBeenCalledWith(
        expect.any(Number),
        'kafka:message:headerless',
        expect.objectContaining({
          value: 'headerless',
          headers: {},
          binaryHeaders: [],
        })
      );
    });
  });

  it('forwards guarded topic, ACL, quota, and cluster admin operations to the native client', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('admin'));

    await handlerFor(IPC.kafka.createPartitions)(event, {
      connectionId: 'admin',
      topic: 'orders',
      count: 6,
      validateOnly: true,
    });
    await handlerFor(IPC.kafka.alterTopicConfigs)(event, {
      connectionId: 'admin',
      topic: 'orders',
      configs: [{ name: 'retention.ms', operation: 'set', value: '60000' }],
      validateOnly: true,
    });
    await handlerFor(IPC.kafka.deleteRecords)(event, {
      connectionId: 'admin',
      topic: 'orders',
      partitions: [{ partition: 0, offset: '42' }],
      confirmation: 'DELETE RECORDS orders',
    });
    const admin = FakeAdmin.instances.at(-1)!;
    expect(admin.deleteRecords).toHaveBeenCalledWith({
      topics: [{ name: 'orders', partitions: [{ partition: 0, offset: 42n }] }],
    });

    const cluster = await handlerFor(IPC.kafka.describeCluster)(event, {
      connectionId: 'admin',
    });
    expect(cluster).toMatchObject({
      success: true,
      cluster: { id: 'cluster-1', controllerId: 1 },
    });

    const acl = {
      resourceType: 2,
      resourceName: 'orders',
      resourcePatternType: 3,
      principal: 'User:restura',
      host: '*',
      operation: 3,
      permissionType: 3,
    };
    await handlerFor(IPC.kafka.createAcl)(event, {
      connectionId: 'admin',
      acl,
      confirmation: 'CREATE ACL',
    });
    await handlerFor(IPC.kafka.alterQuotas)(event, {
      connectionId: 'admin',
      entities: [{ entityType: 'user', entityName: 'restura' }],
      operations: [{ key: 'producer_byte_rate', value: 1024, remove: false }],
      validateOnly: false,
      confirmation: 'ALTER QUOTAS',
    });
    expect(FakeAdmin.instances.some((instance) => instance.createAcls.mock.calls.length > 0)).toBe(
      true
    );
    expect(
      FakeAdmin.instances.some((instance) => instance.alterClientQuotas.mock.calls.length > 0)
    ).toBe(true);
  });

  it('dispatches offset reset (with dry run) and delete-offsets through the admin client', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('offsets'));

    const preview = await handlerFor(IPC.kafka.resetGroupOffsets)(event, {
      connectionId: 'offsets',
      groupId: 'g',
      allTopics: true,
      to: 'shift',
      shift: 2,
      dryRun: true,
    });
    expect(preview).toEqual({
      success: true,
      dryRun: true,
      skipped: [],
      offsets: [{ topic: 'orders', partition: 0, previous: '5', offset: '7' }],
    });
    expect(FakeAdmin.instances.at(-1)!.alterConsumerGroupOffsets).not.toHaveBeenCalled();

    const applied = await handlerFor(IPC.kafka.resetGroupOffsets)(event, {
      connectionId: 'offsets',
      groupId: 'g',
      topic: 'orders',
      to: 'latest',
    });
    expect(applied).toMatchObject({ success: true, dryRun: false });
    expect(FakeAdmin.instances.at(-1)!.alterConsumerGroupOffsets).toHaveBeenCalledWith({
      groupId: 'g',
      topics: [
        {
          name: 'orders',
          partitionOffsets: [0, 1, 2].map((partition) => ({ partition, offset: 9n })),
        },
      ],
    });

    const deleted = await handlerFor(IPC.kafka.deleteGroupOffsets)(event, {
      connectionId: 'offsets',
      groupId: 'g',
      topic: 'orders',
    });
    expect(deleted).toEqual({
      success: true,
      deleted: [{ topic: 'orders', partitions: [0] }],
      skipped: [],
    });
    expect(FakeAdmin.instances.at(-1)!.deleteConsumerGroupOffsets).toHaveBeenCalledWith({
      groupId: 'g',
      topics: [{ name: 'orders', partitionIndexes: [0] }],
    });

    await expect(
      handlerFor(IPC.kafka.deleteGroupOffsets)(event, { connectionId: 'offsets', groupId: 'g' })
    ).rejects.toThrow(/topic is required unless allTopics/);
  });

  it('admin ops run through withAdmin: short-lived Admin, finally-closed, Not connected otherwise', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));

    const res = await handlerFor(IPC.kafka.listTopics)(event, { connectionId: 'c1' });
    expect(res).toEqual({ success: true, topics: ['orders', 'payments'] });
    expect(FakeAdmin.instances).toHaveLength(1);
    expect(FakeAdmin.instances[0]!.close).toHaveBeenCalled();

    const missing = await handlerFor(IPC.kafka.listTopics)(event, { connectionId: 'nope' });
    expect(missing).toEqual({ success: false, error: 'Not connected' });
    expect(FakeAdmin.instances).toHaveLength(1); // no Admin built for an unknown id
  });

  it('explicit disconnect closes the producer, emits close, and drops the entry', async () => {
    const { event, senderId } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    const producer = FakeProducer.instances[0]!;

    const res = await handlerFor(IPC.kafka.disconnect)(event, { connectionId: 'c1' });
    expect(res).toEqual({ success: true });
    expect(producer.close).toHaveBeenCalledWith(true);
    expect(mockEmitTo).toHaveBeenCalledWith(senderId, 'kafka:close:c1', {});

    const after = await handlerFor(IPC.kafka.produce)(event, validProduce('c1'));
    expect(after).toEqual({ success: false, error: 'Not connected' });
  });

  it('reconnecting with the same id closes the previous producer first', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    const [first, second] = FakeProducer.instances;
    expect(first!.close).toHaveBeenCalledWith(true);
    expect(second!.close).not.toHaveBeenCalled();
  });

  it('lets two renderers independently use the same id and cleans up only the destroyed owner', async () => {
    const first = makeEvent();
    const second = makeEvent();
    await expect(
      handlerFor(IPC.kafka.connect)(first.event, validConnect('shared'))
    ).resolves.toEqual({ success: true });
    const firstProducer = FakeProducer.instances[0]!;
    await expect(
      handlerFor(IPC.kafka.produce)(second.event, validProduce('shared'))
    ).resolves.toEqual({ success: false, error: 'Not connected' });
    await expect(
      handlerFor(IPC.kafka.disconnect)(second.event, { connectionId: 'shared' })
    ).resolves.toEqual({ success: true });
    expect(firstProducer.send).not.toHaveBeenCalled();
    expect(firstProducer.close).not.toHaveBeenCalled();

    await expect(
      handlerFor(IPC.kafka.connect)(second.event, validConnect('shared'))
    ).resolves.toEqual({ success: true });
    const secondProducer = FakeProducer.instances[1]!;

    await expect(
      handlerFor(IPC.kafka.produce)(first.event, validProduce('shared'))
    ).resolves.toMatchObject({ success: true });
    await expect(
      handlerFor(IPC.kafka.produce)(second.event, validProduce('shared'))
    ).resolves.toMatchObject({ success: true });
    expect(firstProducer.send).toHaveBeenCalledOnce();
    expect(secondProducer.send).toHaveBeenCalledOnce();

    first.destroy();
    await vi.waitFor(() => expect(firstProducer.close).toHaveBeenCalledWith(true));
    expect(secondProducer.close).not.toHaveBeenCalled();
    await expect(
      handlerFor(IPC.kafka.produce)(second.event, validProduce('shared'))
    ).resolves.toMatchObject({ success: true });
    expect(secondProducer.send).toHaveBeenCalledTimes(2);
  });

  it('reserves concurrent same-id connects independently per renderer before broker setup', async () => {
    const first = makeEvent();
    const second = makeEvent();
    const metadataGate = deferred<void>();
    FakeProducer.metadataGates.push(metadataGate.promise);

    const firstConnect = handlerFor(IPC.kafka.connect)(first.event, validConnect('raced'));
    await vi.waitFor(() => expect(FakeProducer.instances).toHaveLength(1));
    const secondConnect = handlerFor(IPC.kafka.connect)(second.event, validConnect('raced'));

    await expect(secondConnect).resolves.toEqual({ success: true });
    expect(mockBrokersSafe).toHaveBeenCalledTimes(2);
    expect(FakeProducer.instances).toHaveLength(2);

    metadataGate.resolve();
    await expect(firstConnect).resolves.toEqual({ success: true });
    await expect(
      handlerFor(IPC.kafka.produce)(first.event, validProduce('raced'))
    ).resolves.toMatchObject({ success: true });
    await expect(
      handlerFor(IPC.kafka.produce)(second.event, validProduce('raced'))
    ).resolves.toMatchObject({ success: true });
  });

  it('disposes a destroyed renderer pending producer and rejects its late completion', async () => {
    const first = makeEvent();
    const successor = makeEvent();
    const metadataGate = deferred<void>();
    FakeProducer.metadataGates.push(metadataGate.promise);

    const staleConnect = handlerFor(IPC.kafka.connect)(first.event, validConnect('released'));
    await vi.waitFor(() => expect(FakeProducer.instances).toHaveLength(1));
    const staleProducer = FakeProducer.instances[0]!;

    first.destroy();
    await vi.waitFor(() => expect(staleProducer.close).toHaveBeenCalledWith(true));
    await expect(
      handlerFor(IPC.kafka.connect)(successor.event, validConnect('released'))
    ).resolves.toEqual({ success: true });
    const winner = FakeProducer.instances[1]!;

    mockEmitTo.mockClear();
    metadataGate.resolve();
    await expect(staleConnect).resolves.toEqual({ success: false, error: 'Not connected' });
    expect(staleProducer.close).toHaveBeenCalledTimes(1);
    expect(winner.close).not.toHaveBeenCalled();
    expect(mockEmitTo).not.toHaveBeenCalled();
  });

  it('disposes a pending producer during module teardown and rejects its late completion', async () => {
    const first = makeEvent();
    const successor = makeEvent();
    const metadataGate = deferred<void>();
    FakeProducer.metadataGates.push(metadataGate.promise);

    const staleConnect = handlerFor(IPC.kafka.connect)(first.event, validConnect('teardown'));
    await vi.waitFor(() => expect(FakeProducer.instances).toHaveLength(1));
    const staleProducer = FakeProducer.instances[0]!;

    await stopKafkaCleanup();
    expect(staleProducer.close).toHaveBeenCalledWith(true);
    await expect(
      handlerFor(IPC.kafka.connect)(successor.event, validConnect('teardown'))
    ).resolves.toEqual({ success: true });
    const winner = FakeProducer.instances[1]!;

    mockEmitTo.mockClear();
    metadataGate.resolve();
    await expect(staleConnect).resolves.toEqual({ success: false, error: 'Not connected' });
    expect(staleProducer.close).toHaveBeenCalledTimes(1);
    expect(winner.close).not.toHaveBeenCalled();
    expect(mockEmitTo).not.toHaveBeenCalled();
  });

  it('tears the connection down when its renderer is destroyed', async () => {
    const { event, destroy } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    const producer = FakeProducer.instances[0]!;

    destroy();
    // Renderer-destroyed dispose is fire-and-forget async (void closeConnection).
    await vi.waitFor(() => expect(producer.close).toHaveBeenCalledWith(true));

    const res = await handlerFor(IPC.kafka.produce)(event, validProduce('c1'));
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });

  it('stopKafkaCleanup closes every live producer (register/teardown symmetry)', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1'));
    await handlerFor(IPC.kafka.connect)(event, validConnect('c2'));

    await stopKafkaCleanup();
    expect(FakeProducer.instances).toHaveLength(2);
    for (const producer of FakeProducer.instances) {
      expect(producer.close).toHaveBeenCalledWith(true);
    }
    // Entries are gone: a subsequent produce reports Not connected.
    const res = await handlerFor(IPC.kafka.produce)(event, validProduce('c1'));
    expect(res).toEqual({ success: false, error: 'Not connected' });
  });
});
