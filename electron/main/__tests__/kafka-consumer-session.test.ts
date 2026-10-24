// @vitest-environment node

import { EventEmitter } from 'node:events';
import type * as KafkaLib from '@platformatic/kafka';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConsumerSessionEntry,
  type ConsumerSessionOptions,
  fallbackModeValue,
  KafkaConsumerSession,
} from '../handlers/kafka/consumer-session';

const kafka = {
  MessagesStreamModes: { MANUAL: 'MANUAL' },
  MessagesStreamFallbackModes: { LATEST: 'LATEST', EARLIEST: 'EARLIEST', FAIL: 'FAIL' },
  ListOffsetTimestamps: { EARLIEST: -2n, LATEST: -1n },
} as unknown as typeof KafkaLib;

class FakeStream extends EventEmitter {
  pause = vi.fn();
  resume = vi.fn();
  read = vi.fn(() => null);
  close = vi.fn(async () => {});
  offsetsToFetch = new Map([['orders:0', 5n]]);
}

function setup(
  options: Partial<
    Pick<
      ConsumerSessionOptions,
      'swapTimeoutMs' | 'decodeTimeoutMs' | 'autoCommitIntervalMs' | 'fallback'
    >
  > = {}
) {
  const stream = new FakeStream();
  const consumer = Object.assign(new EventEmitter(), {
    assignments: [{ topic: 'orders', partitions: [0] }] as Array<{
      topic: string;
      partitions: number[];
    }>,
    consume: vi.fn(),
    commit: vi.fn(async () => {}),
  });
  const entry = { consumer, emitChain: Promise.resolve() } as unknown as ConsumerSessionEntry;
  const hooks = {
    deliver: vi.fn(async (_msg: unknown, _signal: AbortSignal) => {}),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const session = new KafkaConsumerSession({ topics: ['orders'], kafka, ...options }, hooks);
  entry.session = session;
  session.bind(entry, stream as never);
  return { stream, consumer, entry, hooks, session };
}

const record = (offset: number) => ({
  topic: 'orders',
  partition: 0,
  offset: BigInt(offset),
  leaderEpoch: 0,
});

describe('KafkaConsumerSession timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out a replacement stream that never opens, keeps the old one, and closes the late one', async () => {
    const { stream, consumer, entry, session } = setup({ swapTimeoutMs: 1_000 });
    let resolveLate!: (s: FakeStream) => void;
    consumer.consume.mockReturnValue(
      new Promise((resolve) => {
        resolveLate = resolve;
      })
    );
    stream.resume.mockClear();
    const seek = session.reposition(entry, () => new Map([['orders:0', 1n]]));
    const outcome = expect(seek).rejects.toThrow('Repositioning the consumer timed out.');
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(entry.stream).toBe(stream);
    expect(stream.resume).toHaveBeenCalledTimes(1);

    // The queue is not wedged: the next exclusive task runs.
    await expect(session.runExclusive(async () => 'next')).resolves.toBe('next');

    const late = new FakeStream();
    resolveLate(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  it('skips a record whose decode hangs, reports it, aborts it, and keeps flowing', async () => {
    const { stream, hooks } = setup({ decodeTimeoutMs: 500 });
    const signals: AbortSignal[] = [];
    hooks.deliver.mockImplementationOnce(async (_msg, signal) => {
      signals.push(signal);
      await new Promise(() => {}); // a registry lookup that never answers
    });
    stream.emit('data', record(1));
    stream.emit('data', record(2));
    await vi.advanceTimersByTimeAsync(500);
    expect(signals[0]!.aborted).toBe(true);
    expect(hooks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Decoding orders[0]@1 timed out; the record was skipped.',
      })
    );
    await vi.waitFor(() => expect(hooks.deliver).toHaveBeenCalledTimes(2));
  });

  it('abandons a swap when the session is closed while the replacement opens', async () => {
    const { stream, consumer, entry, session } = setup();
    let resolveLate!: (s: FakeStream) => void;
    consumer.consume.mockReturnValue(
      new Promise((resolve) => {
        resolveLate = resolve;
      })
    );
    const seek = session.reposition(entry, () => new Map([['orders:0', 1n]]));
    const outcome = expect(seek).rejects.toThrow('The consumer was closed while repositioning.');
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
    const late = new FakeStream();
    resolveLate(late);
    await outcome;
    expect(entry.stream).toBe(stream);
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.resume).not.toHaveBeenCalled();
    expect(late.listenerCount('data')).toBe(0);
  });

  it('does not commit records delivered after their partition was revoked', async () => {
    const { stream, consumer, hooks, session } = setup({ autoCommitIntervalMs: 60_000 });
    let finishDelivery!: () => void;
    hooks.deliver.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelivery = resolve;
        })
    );
    stream.emit('data', record(1)); // queued while orders:0 is still ours
    await vi.advanceTimersByTimeAsync(0);
    consumer.assignments = [{ topic: 'orders', partitions: [1] }];
    consumer.emit('consumer:group:join', {});
    await vi.advanceTimersByTimeAsync(0);
    finishDelivery();
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
    expect(consumer.commit).not.toHaveBeenCalled();
  });

  it('drops positions for partitions no longer assigned at flush time', async () => {
    const { stream, consumer, session } = setup({ autoCommitIntervalMs: 60_000 });
    consumer.assignments = [{ topic: 'orders', partitions: [0, 1] }];
    stream.emit('data', record(1));
    stream.emit('data', { ...record(4), partition: 1 });
    await vi.advanceTimersByTimeAsync(0);
    // Revoked without a join event having been processed yet.
    consumer.assignments = [{ topic: 'orders', partitions: [1] }];
    await session.close();
    expect(consumer.commit).toHaveBeenCalledTimes(1);
    expect(consumer.commit).toHaveBeenCalledWith({
      offsets: [{ topic: 'orders', partition: 1, offset: 5n, leaderEpoch: 0 }],
    });
  });

  it('a seek fences old-stream deliveries of the sought partition from the commit', async () => {
    const { stream, consumer, entry, hooks, session } = setup({ autoCommitIntervalMs: 60_000 });
    consumer.assignments = [{ topic: 'orders', partitions: [0, 1] }];
    const pending: Array<() => void> = [];
    hooks.deliver.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        })
    );
    // Old-stream records queued before a backward seek on orders:0.
    stream.emit('data', record(99));
    stream.emit('data', { ...record(7), partition: 1 });
    const next = new FakeStream();
    consumer.consume.mockResolvedValue(next);
    await session.reposition(entry, () => new Map([['orders:0', 10n]]));
    expect(entry.stream).toBe(next);

    // The stale deliveries complete after the swap.
    for (let i = 0; i < 10 && pending.length < 2; i += 1) await vi.advanceTimersByTimeAsync(0);
    while (pending.length > 0) {
      pending.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await session.close();
    // orders:1 was not sought: its delivered position still commits. orders:0's
    // pre-seek position must not (nor is the seek target committed undelivered).
    expect(consumer.commit).toHaveBeenCalledTimes(1);
    expect(consumer.commit).toHaveBeenCalledWith({
      offsets: [{ topic: 'orders', partition: 1, offset: 8n, leaderEpoch: 0 }],
    });
  });

  it("keeps the 'fail' fallback after a swap: a rebalance without a commit stops the stream", async () => {
    const { consumer, entry, hooks, session } = setup({ fallback: 'fail' });
    const listOffsets = vi.fn();
    Object.assign(consumer, {
      listCommittedOffsets: vi.fn(async () => new Map([['orders', [-1n, -1n]]])),
      listOffsets,
    });
    const next = Object.assign(new FakeStream(), { destroy: vi.fn() });
    consumer.consume.mockResolvedValue(next);
    await session.reposition(entry, () => new Map([['orders:0', 1n]]));
    consumer.assignments = [{ topic: 'orders', partitions: [0, 1] }];
    consumer.emit('consumer:group:join', {});
    await vi.waitFor(() => expect(next.destroy).toHaveBeenCalledTimes(1));
    expect(next.destroy.mock.calls[0]![0].message).toBe(
      'Topic orders has no committed offset on partition 1 and the fallback mode is "fail".'
    );
    expect(listOffsets).not.toHaveBeenCalled();
    expect(consumer.consume).toHaveBeenCalledTimes(1);
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it('maps fallback strings to library values', () => {
    expect(fallbackModeValue(kafka, undefined)).toBeUndefined();
    expect(fallbackModeValue(kafka, 'earliest')).toBe('EARLIEST');
    expect(fallbackModeValue(kafka, 'fail')).toBe('FAIL');
    expect(fallbackModeValue(kafka, 'latest')).toBe('LATEST');
  });

  it('refuses to reposition once closed', async () => {
    const { entry, session } = setup();
    await session.close();
    await session.close();
    await expect(session.reposition(entry, () => new Map())).rejects.toThrow(
      'No consumer is active.'
    );
  });
});
