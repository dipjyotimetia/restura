// @vitest-environment node

import { EventEmitter } from 'node:events';
import type * as KafkaLib from '@platformatic/kafka';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConsumerSessionEntry,
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

function setup(options: { swapTimeoutMs?: number; decodeTimeoutMs?: number } = {}) {
  const stream = new FakeStream();
  const consumer = Object.assign(new EventEmitter(), {
    assignments: [{ topic: 'orders', partitions: [0] }],
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
