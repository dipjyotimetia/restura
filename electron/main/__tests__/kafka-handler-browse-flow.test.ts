// @vitest-environment node
//
// Browse-mode emission bounds through the real kafka:subscribe handler: the
// ordered decode/emit queue pauses the stream past its high-water mark, a hung
// decode is skipped after the decode timeout, and unsubscribe/disconnect abort
// queued deliveries so nothing more is decoded or sent.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockDecode = vi.hoisted(() => vi.fn());
const browseStreams = vi.hoisted(() => [] as unknown[]);

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
vi.mock('../handlers/kafka-serde', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../handlers/kafka-serde')>()),
  decodeDisplayField: mockDecode,
}));
vi.mock('../handlers/kafka/browse-consumer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../handlers/kafka/browse-consumer')>()),
  openBrowseStream: vi.fn(async () => {
    const stream = Object.assign(new EventEmitter(), {
      pause: vi.fn(),
      resume: vi.fn(),
      close: vi.fn(async () => {}),
      destroy: vi.fn(),
    });
    browseStreams.push(stream);
    return stream;
  }),
}));

import type * as KafkaLib from '@platformatic/kafka';
import { IPC } from '../../shared/channels';
import { KAFKA_CHANNEL, kafkaChannel } from '../../shared/kafka-channels';
import {
  __setKafkaForTests,
  registerKafkaHandlerIPC,
  stopKafkaCleanup,
} from '../handlers/kafka-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type FakeBrowseStream = EventEmitter & {
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

class FakeProducer {
  metadata = vi.fn(async () => new Map());
  close = vi.fn(async () => {});
}

class FakeConsumer extends EventEmitter {
  close = vi.fn(async () => {});
}

const fakeKafkaLib = {
  Producer: FakeProducer,
  Consumer: FakeConsumer,
} as unknown as typeof KafkaLib;

type Result = { success: boolean; error?: string };
const handlerFor = (channel: string) =>
  mockHandle.mock.calls.find((c) => c[0] === channel)?.[1] as (
    e: unknown,
    p: unknown
  ) => Promise<Result>;

let nextSenderId = 9500;
async function browsing(connectionId: string) {
  const event = {
    sender: { id: nextSenderId++, isDestroyed: () => false, once: vi.fn() },
    senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
  };
  const connected = await handlerFor(IPC.kafka.connect)(event, {
    connectionId,
    clientId: 'restura-test',
    bootstrapBrokers: ['broker.example.com:9092'],
    auth: { securityProtocol: 'PLAINTEXT' },
  });
  expect(connected.success).toBe(true);
  const subscribed = await handlerFor(IPC.kafka.subscribe)(event, {
    connectionId,
    membership: 'browse',
    topics: ['orders'],
    mode: 'earliest',
  });
  expect(subscribed).toEqual({ success: true });
  return { event, stream: browseStreams.at(-1) as FakeBrowseStream };
}

const record = (offset: number) => ({
  topic: 'orders',
  partition: 0,
  offset: BigInt(offset),
  value: Buffer.from(`v${offset}`),
  headers: new Map(),
});

const emitted = (channel: string) =>
  mockEmitTo.mock.calls.filter((c) => c[1] === channel).map((c) => c[2]);

const decoded = (buf: Buffer) => ({ value: buf.toString(), encoding: 'utf8' as const });

describe('kafka-handler browse-mode emission bounds', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    mockDecode.mockReset();
    mockDecode.mockImplementation(async (_registry: unknown, buf: Buffer) => decoded(buf));
    browseStreams.length = 0;
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
    vi.useRealTimers();
    await stopKafkaCleanup();
    __setKafkaForTests(undefined);
  });

  it('pauses the browse stream once more than 500 emits are queued, and resumes on drain', async () => {
    const { stream } = await browsing('f1');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockDecode.mockImplementation(async (_registry: unknown, buf: Buffer) => {
      await gate;
      return decoded(buf);
    });
    stream.resume.mockClear();
    for (let i = 0; i < 600; i += 1) stream.emit('data', record(i));
    expect(stream.pause).toHaveBeenCalled();
    expect(stream.resume).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() =>
      expect(emitted(kafkaChannel(KAFKA_CHANNEL.MESSAGE, 'f1'))).toHaveLength(600)
    );
    expect(stream.resume).toHaveBeenCalled();
  });

  it('unsubscribe aborts queued deliveries: nothing more is decoded or sent', async () => {
    const { event, stream } = await browsing('f2');
    let release!: () => void;
    mockDecode.mockImplementationOnce(
      (_registry: unknown, buf: Buffer) =>
        new Promise((resolve) => {
          release = () => resolve(decoded(buf));
        })
    );
    for (let i = 0; i < 5; i += 1) stream.emit('data', record(i));
    await vi.waitFor(() => expect(mockDecode).toHaveBeenCalledTimes(1));

    expect((await handlerFor(IPC.kafka.unsubscribe)(event, { connectionId: 'f2' })).success).toBe(
      true
    );
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted(kafkaChannel(KAFKA_CHANNEL.MESSAGE, 'f2'))).toEqual([]);
    expect(mockDecode).toHaveBeenCalledTimes(1);
  });

  it('disconnect aborts queued deliveries the same way', async () => {
    const { event, stream } = await browsing('f3');
    let release!: () => void;
    mockDecode.mockImplementationOnce(
      (_registry: unknown, buf: Buffer) =>
        new Promise((resolve) => {
          release = () => resolve(decoded(buf));
        })
    );
    for (let i = 0; i < 3; i += 1) stream.emit('data', record(i));
    await vi.waitFor(() => expect(mockDecode).toHaveBeenCalledTimes(1));
    await handlerFor(IPC.kafka.disconnect)(event, { connectionId: 'f3' });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted(kafkaChannel(KAFKA_CHANNEL.MESSAGE, 'f3'))).toEqual([]);
    expect(mockDecode).toHaveBeenCalledTimes(1);
  });

  it('skips a browse record whose decode hangs past the decode timeout', async () => {
    const { stream } = await browsing('f4');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockDecode.mockImplementationOnce(() => new Promise(() => {}));
    stream.emit('data', record(0));
    stream.emit('data', record(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() =>
      expect(emitted(kafkaChannel(KAFKA_CHANNEL.MESSAGE, 'f4'))).toHaveLength(1)
    );
    const [message] = emitted(kafkaChannel(KAFKA_CHANNEL.MESSAGE, 'f4')) as Array<{
      offset: string;
    }>;
    expect(message?.offset).toBe('1');
    expect(emitted(kafkaChannel(KAFKA_CHANNEL.ERROR, 'f4'))).toEqual([
      { scope: 'consumer', message: 'Decoding orders[0]@0 timed out; the record was skipped.' },
    ]);
  });

  it('a user pause holds the browse stream even after backpressure drains', async () => {
    const { event, stream } = await browsing('f5');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockDecode.mockImplementation(async (_registry: unknown, buf: Buffer) => {
      await gate;
      return decoded(buf);
    });
    for (let i = 0; i < 600; i += 1) stream.emit('data', record(i));
    await handlerFor(IPC.kafka.pauseConsumer)(event, { connectionId: 'f5' });
    stream.resume.mockClear();
    release();
    await vi.waitFor(() =>
      expect(emitted(kafkaChannel(KAFKA_CHANNEL.MESSAGE, 'f5'))).toHaveLength(600)
    );
    expect(stream.resume).not.toHaveBeenCalled();
    await handlerFor(IPC.kafka.resumeConsumer)(event, { connectionId: 'f5' });
    expect(stream.resume).toHaveBeenCalledTimes(1);
  });
});
