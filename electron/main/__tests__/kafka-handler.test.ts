// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockBrokersSafe = vi.hoisted(() => vi.fn());
const mockRegistryUrlSafe = vi.hoisted(() => vi.fn());

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
import { IPC } from '../../shared/channels';
import {
  __setKafkaForTests,
  kafkaRateLimiter,
  registerKafkaHandlerIPC,
  stopKafkaCleanup,
} from '../handlers/kafka-handler';

// Fake @platformatic/kafka. NOT injectable via vi.mock — the handler loads the
// lib through a lazy bare `require('@platformatic/kafka')`, which vitest's
// ESM-level mocking does not intercept — so it goes in through the module's
// __setKafkaForTests seam instead. Producer/Admin record instances so tests can
// assert construction, send/close forwarding, and teardown symmetry.
class FakeProducer {
  static instances: FakeProducer[] = [];
  options: unknown;
  send = vi.fn(async () => ({ offsets: [{ topic: 'orders', partition: 0, offset: 7n }] }));
  close = vi.fn(async () => {});
  constructor(options: unknown) {
    this.options = options;
    FakeProducer.instances.push(this);
  }
}
class FakeAdmin {
  static instances: FakeAdmin[] = [];
  listTopics = vi.fn(async () => ['orders', 'payments']);
  close = vi.fn(async () => {});
  constructor(_options: unknown) {
    FakeAdmin.instances.push(this);
  }
}
class FakeConsumer {
  constructor(_options: unknown) {
    throw new Error('No test here should construct a Consumer');
  }
}
const fakeKafkaLib = {
  Producer: FakeProducer,
  Admin: FakeAdmin,
  Consumer: FakeConsumer,
  MessagesStreamModes: { LATEST: 'LATEST', EARLIEST: 'EARLIEST', MANUAL: 'MANUAL' },
  ListOffsetTimestamps: { EARLIEST: -2n, LATEST: -1n },
  ConfigResourceTypes: { TOPIC: 2 },
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
  topic: 'orders',
  value: 'hello',
  acks: 1,
  ...extra,
});

describe('kafka-handler', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockBrokersSafe.mockClear();
    mockRegistryUrlSafe.mockClear();
    FakeProducer.instances.length = 0;
    FakeAdmin.instances.length = 0;
    __setKafkaForTests(fakeKafkaLib);
    registerKafkaHandlerIPC();
  });
  afterEach(async () => {
    await stopKafkaCleanup();
    __setKafkaForTests(undefined);
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
    expect(mockBrokersSafe).toHaveBeenCalledWith(['broker.example.com:9092']);
    expect(FakeProducer.instances).toHaveLength(1);
    expect(mockEmitTo).toHaveBeenCalledWith(
      senderId,
      'kafka:connected:c1',
      expect.objectContaining({ timestamp: expect.any(Number) })
    );
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
        messages: [expect.objectContaining({ topic: 'orders', value: 'hello' })],
      })
    );

    const missing = await handlerFor(IPC.kafka.produce)(event, validProduce('nope'));
    expect(missing).toEqual({ success: false, error: 'Not connected' });
  });

  it('an idempotent connection forces acks=-1 on produce regardless of the payload acks', async () => {
    const { event } = makeEvent();
    await handlerFor(IPC.kafka.connect)(event, validConnect('c1', { idempotent: true }));
    await handlerFor(IPC.kafka.produce)(event, validProduce('c1', { acks: 0 }));
    expect(FakeProducer.instances[0]!.send).toHaveBeenCalledWith(
      expect.objectContaining({ acks: -1 })
    );
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
