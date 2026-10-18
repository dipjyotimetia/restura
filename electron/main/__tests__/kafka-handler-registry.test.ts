// @vitest-environment node
// Handler-level wiring for the Schema Registry client (#922, #926, #982):
// connect builds the client with the active security policy, subject-based
// produce fields resolve to an id in main, consumed records carry schema
// labels, and the client is closed with the connection (or on failed connect).

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockCreateRegistry = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  webContents: { fromId: vi.fn(() => undefined) },
}));
vi.mock('../ipc/ipc-utils', () => ({
  emitTo: mockEmitTo,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock('../security/kafka-broker-guard', () => ({
  assertKafkaBrokersSafe: vi.fn(),
  assertRegistryUrlSafe: vi.fn(),
}));
vi.mock('../handlers/kafka/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../handlers/kafka/registry')>()),
  createKafkaRegistryClient: mockCreateRegistry,
}));

import type * as KafkaLib from '@platformatic/kafka';
import { IPC } from '../../shared/channels';
import {
  __setKafkaForTests,
  registerKafkaHandlerIPC,
  stopKafkaCleanup,
} from '../handlers/kafka-handler';
import { setExecutionPolicy } from '../security/execution-policy';

class FakeProducer {
  static last: FakeProducer | undefined;
  static failMetadata = false;
  send = vi.fn(async () => ({ offsets: [{ topic: 'orders', partition: 0, offset: 1n }] }));
  metadata = vi.fn(async () => {
    if (FakeProducer.failMetadata) throw new Error('broker down');
    return new Map();
  });
  close = vi.fn(async () => {});
  constructor() {
    FakeProducer.last = this;
  }
}
class FakeStream extends EventEmitter {
  close = vi.fn(async () => {});
}
class FakeConsumer extends EventEmitter {
  static last: FakeConsumer | undefined;
  stream = new FakeStream();
  consume = vi.fn(async () => this.stream);
  close = vi.fn(async () => {});
  constructor() {
    super();
    FakeConsumer.last = this;
  }
}
const fakeKafka = {
  Producer: FakeProducer,
  Consumer: FakeConsumer,
  MessagesStreamModes: { LATEST: 'L', EARLIEST: 'E', COMMITTED: 'C', MANUAL: 'M' },
  MessagesStreamFallbackModes: { LATEST: 'L', EARLIEST: 'E', FAIL: 'F' },
  GroupProtocols: { CLASSIC: 'classic', CONSUMER: 'consumer' },
} as unknown as typeof KafkaLib;

function makeRegistry() {
  return {
    encode: vi.fn(async (id: number) => Buffer.from([0, 0, 0, 0, id, 1])),
    decode: vi.fn(async () => ({ ok: true })),
    resolveSchemaId: vi.fn(async (ref: { subject: string; version: unknown }) => {
      if (ref.subject === 'missing') throw new Error('Schema subject "missing" not found');
      return 12;
    }),
    describeSchemaId: vi.fn(async (id: number) => ({ id, subject: 'orders-value', version: 3 })),
    listSubjects: vi.fn(),
    listVersions: vi.fn(),
    getSchema: vi.fn(),
    close: vi.fn(),
  };
}

let nextSender = 7000;
const event = () => ({
  sender: { id: nextSender++, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
});
type Handler = (e: unknown, p: unknown) => Promise<Record<string, unknown>>;
const handlerFor = (channel: string) =>
  mockHandle.mock.calls.find((c) => c[0] === channel)?.[1] as Handler;

const connectInput = {
  connectionId: 'reg',
  clientId: 'restura-test',
  bootstrapBrokers: ['broker.example.com:9092'],
  auth: { securityProtocol: 'PLAINTEXT' },
  registry: { url: 'https://registry.example.com', auth: { type: 'bearer', token: 't' } },
};

describe('kafka-handler schema registry wiring', () => {
  let registry: ReturnType<typeof makeRegistry>;
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    FakeProducer.failMetadata = false;
    registry = makeRegistry();
    mockCreateRegistry.mockReset().mockResolvedValue(registry);
    setExecutionPolicy({
      security: { allowLocalhost: false, allowPrivateIPs: true },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    __setKafkaForTests(fakeKafka);
    registerKafkaHandlerIPC();
  });
  afterEach(async () => {
    await stopKafkaCleanup();
    __setKafkaForTests(undefined);
  });

  it('builds the registry client with the active network policy and bearer auth', async () => {
    const ev = event();
    expect(await handlerFor(IPC.kafka.connect)(ev, connectInput)).toEqual({ success: true });
    expect(mockCreateRegistry).toHaveBeenCalledWith(
      { url: 'https://registry.example.com', auth: { type: 'bearer', token: 't' } },
      { allowLocalhost: false, allowPrivateIPs: true }
    );
  });

  it('resolves subject + version to a schema id before encoding', async () => {
    const ev = event();
    await handlerFor(IPC.kafka.connect)(ev, connectInput);
    const result = await handlerFor(IPC.kafka.produce)(ev, {
      connectionId: 'reg',
      acks: 1,
      record: {
        topic: 'orders',
        key: { encoding: 'schema', schemaId: 4, data: '"k"' },
        value: { encoding: 'schema', subject: 'orders-value', version: 'latest', data: '{"a":1}' },
      },
    });
    expect(result).toMatchObject({ success: true });
    expect(registry.resolveSchemaId).toHaveBeenCalledWith({
      subject: 'orders-value',
      version: 'latest',
    });
    expect(registry.encode).toHaveBeenCalledWith(12, { a: 1 });
    expect(registry.encode).toHaveBeenCalledWith(4, 'k');
  });

  it('fails the produce with a clear error when the subject is missing', async () => {
    const ev = event();
    await handlerFor(IPC.kafka.connect)(ev, connectInput);
    const result = await handlerFor(IPC.kafka.produce)(ev, {
      connectionId: 'reg',
      acks: 1,
      record: {
        topic: 'orders',
        value: { encoding: 'schema', subject: 'missing', version: 2, data: '{}' },
      },
    });
    expect(result).toEqual({ success: false, error: 'Schema subject "missing" not found' });
    expect(FakeProducer.last?.send).not.toHaveBeenCalled();
  });

  it('labels decoded consumed fields with the schema subject/version', async () => {
    const ev = event();
    await handlerFor(IPC.kafka.connect)(ev, connectInput);
    await handlerFor(IPC.kafka.subscribe)(ev, {
      connectionId: 'reg',
      groupId: 'g',
      topics: ['orders'],
    });
    FakeConsumer.last!.stream.emit('data', {
      topic: 'orders',
      partition: 0,
      offset: 1n,
      key: Buffer.from('plain-key'),
      value: Buffer.from([0, 0, 0, 0, 12, 9]),
      headers: new Map(),
      timestamp: 1n,
    });
    await vi.waitFor(() =>
      expect(mockEmitTo).toHaveBeenCalledWith(
        expect.any(Number),
        'kafka:message:reg',
        expect.objectContaining({
          key: 'plain-key',
          value: '{"ok":true}',
          valueSchema: { id: 12, subject: 'orders-value', version: 3 },
        })
      )
    );
    const payload = mockEmitTo.mock.calls.find((c) => c[1] === 'kafka:message:reg')?.[2];
    expect(payload).not.toHaveProperty('keySchema');
  });

  it('closes the registry client on disconnect and after a failed connect', async () => {
    const ev = event();
    await handlerFor(IPC.kafka.connect)(ev, connectInput);
    expect(registry.close).not.toHaveBeenCalled();
    await handlerFor(IPC.kafka.disconnect)(ev, { connectionId: 'reg' });
    expect(registry.close).toHaveBeenCalledTimes(1);

    const failing = makeRegistry();
    mockCreateRegistry.mockResolvedValueOnce(failing);
    FakeProducer.failMetadata = true;
    expect(await handlerFor(IPC.kafka.connect)(event(), connectInput)).toEqual({
      success: false,
      error: 'broker down',
    });
    expect(failing.close).toHaveBeenCalledTimes(1);
  });

  it('reports a registry construction failure as a connect error', async () => {
    mockCreateRegistry.mockRejectedValueOnce(new Error('Schema Registry URL rejected'));
    expect(await handlerFor(IPC.kafka.connect)(event(), connectInput)).toEqual({
      success: false,
      error: 'Schema Registry URL rejected',
    });
  });
});
