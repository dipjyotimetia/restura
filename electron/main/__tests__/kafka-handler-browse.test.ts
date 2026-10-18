// @vitest-environment node
//
// Browse-mode dispatch through the real kafka:subscribe handler (#930/#980):
// the browse path must build a group-less Consumer and never reach consume(),
// commit(), joinGroup() or lag monitoring; group mode keeps the native path.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

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

import type * as KafkaLib from '@platformatic/kafka';
import { IPC } from '../../shared/channels';
import { KAFKA_CHANNEL, kafkaChannel } from '../../shared/kafka-channels';
import { BROWSE_PLACEHOLDER_GROUP_ID } from '../handlers/kafka/browse-consumer';
import {
  __setKafkaForTests,
  registerKafkaHandlerIPC,
  stopKafkaCleanup,
} from '../handlers/kafka-handler';
import { setExecutionPolicy } from '../security/execution-policy';

class FakeProducer {
  metadata = vi.fn(async () => new Map());
  close = vi.fn(async () => {});
}

class FakeConsumer extends EventEmitter {
  static instances: FakeConsumer[] = [];
  static fetchPlan: Array<Array<{ offset: number; value: string }>> = [];
  options: Record<string, unknown>;
  stream = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(async () => {}),
  });
  consume = vi.fn(async () => this.stream);
  commit = vi.fn(async () => {});
  joinGroup = vi.fn(async () => 'member');
  startLagMonitoring = vi.fn();
  close = vi.fn(async () => {});
  topics = { trackAll: vi.fn() };
  listOffsets = vi.fn(
    async ({ timestamp }: { timestamp: bigint }) =>
      new Map([['orders', [timestamp === -2n ? 0n : 3n]]])
  );
  listOffsetsWithTimestamps = vi.fn(async () => new Map());
  metadata = vi.fn(async () => ({
    topics: new Map([
      ['orders', { id: 'id-orders', partitionsCount: 1, partitions: [{ leader: 1 }] }],
    ]),
  }));
  fetch = vi.fn(async () => {
    const records = FakeConsumer.fetchPlan.shift();
    if (!records) await new Promise(() => {}); // long-poll that never returns
    return {
      responses: [
        {
          topicId: 'id-orders',
          partitions: [
            {
              partitionIndex: 0,
              records: [
                {
                  firstOffset: BigInt(records?.[0]?.offset ?? 0),
                  lastOffsetDelta: (records?.length ?? 1) - 1,
                  firstTimestamp: 1n,
                  attributes: 0,
                  partitionLeaderEpoch: 0,
                  records: (records ?? []).map((r, i) => ({
                    offsetDelta: i,
                    timestampDelta: 0n,
                    key: null,
                    value: Buffer.from(r.value),
                    headers: [],
                  })),
                },
              ],
            },
          ],
        },
      ],
    };
  });
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    FakeConsumer.instances.push(this);
  }
}

const fakeKafkaLib = {
  Producer: FakeProducer,
  Consumer: FakeConsumer,
  MessagesStreamModes: { LATEST: 'L', EARLIEST: 'E', COMMITTED: 'C', MANUAL: 'M' },
  MessagesStreamFallbackModes: { LATEST: 'L', EARLIEST: 'E', FAIL: 'F' },
  GroupProtocols: { CLASSIC: 'classic', CONSUMER: 'consumer' },
} as unknown as typeof KafkaLib;

type Result = { success: boolean; error?: string };
const handlerFor = (channel: string) =>
  mockHandle.mock.calls.find((c) => c[0] === channel)?.[1] as (
    e: unknown,
    p: unknown
  ) => Promise<Result>;

let nextSenderId = 9000;
function makeEvent() {
  const id = nextSenderId++;
  return {
    sender: { id, isDestroyed: () => false, once: vi.fn() },
    senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
  };
}

async function connected(connectionId: string) {
  const event = makeEvent();
  const result = await handlerFor(IPC.kafka.connect)(event, {
    connectionId,
    clientId: 'restura-test',
    bootstrapBrokers: ['broker.example.com:9092'],
    auth: { securityProtocol: 'PLAINTEXT' },
  });
  expect(result.success).toBe(true);
  return event;
}

const emitted = (channel: string) =>
  mockEmitTo.mock.calls.filter((c) => c[1] === channel).map((c) => c[2]);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe('kafka-handler browse mode', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    FakeConsumer.instances.length = 0;
    FakeConsumer.fetchPlan.length = 0;
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: true },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    __setKafkaForTests(fakeKafkaLib);
    registerKafkaHandlerIPC();
  });
  afterEach(async () => {
    await stopKafkaCleanup();
    __setKafkaForTests(undefined);
  });

  it('streams records without consume(), commits, group joins or lag monitoring', async () => {
    const event = await connected('b1');
    FakeConsumer.fetchPlan.push([
      { offset: 0, value: 'a' },
      { offset: 1, value: 'b' },
    ]);
    const result = await handlerFor(IPC.kafka.subscribe)(event, {
      connectionId: 'b1',
      membership: 'browse',
      topics: ['orders'],
      mode: 'earliest',
      lagIntervalMs: 1000,
    });
    expect(result).toEqual({ success: true });

    const consumer = FakeConsumer.instances[0]!;
    expect(consumer.options).toMatchObject({
      groupId: BROWSE_PLACEHOLDER_GROUP_ID,
      autocommit: false,
    });
    expect(consumer.options).not.toHaveProperty('groupProtocol');
    expect(consumer.options).not.toHaveProperty('groupInstanceId');

    const messageChannel = kafkaChannel(KAFKA_CHANNEL.MESSAGE, 'b1');
    await until(() => emitted(messageChannel).length === 2);
    const messages = emitted(messageChannel) as Array<Record<string, unknown>>;
    expect(messages.map((m) => [m.offset, m.value])).toEqual([
      ['0', 'a'],
      ['1', 'b'],
    ]);
    // No commit token: browse never offers the manual-commit control.
    expect(messages.every((m) => !('commitToken' in m))).toBe(true);
    expect(consumer.consume).not.toHaveBeenCalled();
    expect(consumer.commit).not.toHaveBeenCalled();
    expect(consumer.joinGroup).not.toHaveBeenCalled();
    expect(consumer.startLagMonitoring).not.toHaveBeenCalled();

    // Pause/resume and unsubscribe drive the browse stream like a native one.
    expect((await handlerFor(IPC.kafka.pauseConsumer)(event, { connectionId: 'b1' })).success).toBe(
      true
    );
    expect(
      (await handlerFor(IPC.kafka.resumeConsumer)(event, { connectionId: 'b1' })).success
    ).toBe(true);
    expect((await handlerFor(IPC.kafka.unsubscribe)(event, { connectionId: 'b1' })).success).toBe(
      true
    );
    expect(consumer.close).toHaveBeenCalled();
  });

  it('releases the consumer when a stop-after-N limit ends the stream', async () => {
    const event = await connected('b2');
    FakeConsumer.fetchPlan.push([
      { offset: 0, value: 'a' },
      { offset: 1, value: 'b' },
    ]);
    await handlerFor(IPC.kafka.subscribe)(event, {
      connectionId: 'b2',
      membership: 'browse',
      topics: ['orders'],
      mode: 'last-n',
      lastN: 5,
      maxMessages: 1,
    });
    const consumer = FakeConsumer.instances[0]!;
    await until(() => consumer.close.mock.calls.length > 0);
    expect(emitted(kafkaChannel(KAFKA_CHANNEL.MESSAGE, 'b2'))).toHaveLength(1);
    expect(emitted(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, 'b2'))).toHaveLength(1);
    // The slot is free again: a new subscribe is accepted.
    FakeConsumer.fetchPlan.push([{ offset: 2, value: 'c' }]);
    const again = await handlerFor(IPC.kafka.subscribe)(event, {
      connectionId: 'b2',
      membership: 'browse',
      topics: ['orders'],
      mode: 'latest',
    });
    expect(again.success).toBe(true);
  });

  it('a browse commit request finds no token to commit', async () => {
    const event = await connected('b3');
    await handlerFor(IPC.kafka.subscribe)(event, {
      connectionId: 'b3',
      membership: 'browse',
      topics: ['orders'],
      mode: 'latest',
    });
    const result = await handlerFor(IPC.kafka.commitMessage)(event, {
      connectionId: 'b3',
      commitToken: 'anything',
    });
    expect(result.success).toBe(false);
    expect(FakeConsumer.instances[0]!.commit).not.toHaveBeenCalled();
  });

  it('surfaces a start-position failure and closes the consumer', async () => {
    const event = await connected('b4');
    const result = await handlerFor(IPC.kafka.subscribe)(event, {
      connectionId: 'b4',
      membership: 'browse',
      topics: ['orders'],
      mode: 'manual',
      offsets: [{ topic: 'orders', partition: 4, offset: '0' }],
    });
    expect(result).toEqual({ success: false, error: 'Topic orders has no partition 4.' });
    expect(FakeConsumer.instances[0]!.close).toHaveBeenCalled();
  });

  it('keeps group mode on the native consume() path with its groupId', async () => {
    const event = await connected('g1');
    const result = await handlerFor(IPC.kafka.subscribe)(event, {
      connectionId: 'g1',
      groupId: 'team-group',
      topics: ['orders'],
      mode: 'latest',
    });
    expect(result.success).toBe(true);
    const consumer = FakeConsumer.instances[0]!;
    expect(consumer.options).toMatchObject({ groupId: 'team-group' });
    expect(consumer.consume).toHaveBeenCalled();
    expect(consumer.listOffsets).not.toHaveBeenCalled();
  });
});
