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
  consume = vi.fn(async () => this.stream);
  close = vi.fn(async () => {});
  startLagMonitoring = vi.fn();
  constructor(options: unknown) {
    super();
    this.options = options;
    FakeConsumer.instances.push(this);
  }
}
class FakeConsumerStream extends EventEmitter {
  pause = vi.fn(() => this);
  resume = vi.fn(() => this);
  close = vi.fn(async () => {});
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
