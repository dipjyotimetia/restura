// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { ConsumerFlowControl } from '../handlers/kafka/consumer-flow';
import {
  PartitionPauseSet,
  parsePartitionKey,
  partitionKey,
} from '../handlers/kafka/partition-pause';

describe('PartitionPauseSet', () => {
  it('withholds paused-partition records and remembers the earliest withheld offset', () => {
    const paused = new PartitionPauseSet();
    paused.pause('orders', 1);
    expect(paused.isPaused('orders', 1)).toBe(true);
    expect(paused.admit('orders', 0, 5n)).toBe(true);
    expect(paused.admit('orders', 1, 10n)).toBe(false);
    expect(paused.admit('orders', 1, 11n)).toBe(false);
    expect(paused.admit('orders', 1, 7n)).toBe(false);
    expect(paused.list()).toEqual([{ topic: 'orders', partition: 1 }]);
    expect(paused.resume('orders', 1)).toBe(7n);
    expect(paused.isPaused('orders', 1)).toBe(false);
    expect(paused.admit('orders', 1, 12n)).toBe(true);
  });

  it('pausing twice keeps the original rewind point; resuming an idle partition needs no rewind', () => {
    const paused = new PartitionPauseSet();
    paused.pause('orders', 0);
    paused.admit('orders', 0, 3n);
    paused.pause('orders', 0);
    expect(paused.resume('orders', 0)).toBe(3n);
    paused.pause('orders', 2);
    expect(paused.resume('orders', 2)).toBeUndefined();
    expect(paused.resume('never-paused', 0)).toBeUndefined();
  });

  it('seeking a paused partition moves its rewind point; non-paused partitions are ignored', () => {
    const paused = new PartitionPauseSet();
    paused.pause('orders', 0);
    paused.admit('orders', 0, 50n);
    paused.setRewindPoint('orders', 0, 2n);
    paused.setRewindPoint('orders', 9, 2n);
    expect(paused.isPaused('orders', 9)).toBe(false);
    expect(paused.resume('orders', 0)).toBe(2n);
  });

  it('a seek pins the resume point against records withheld afterwards', () => {
    const paused = new PartitionPauseSet();
    paused.pause('orders', 0);
    paused.setRewindPoint('orders', 0, 60n);
    expect(paused.admit('orders', 0, 21n)).toBe(false);
    expect(paused.resume('orders', 0)).toBe(60n);
  });

  it('is independent of the whole-stream pause reasons (user + backpressure)', () => {
    const stream = { pause: vi.fn(), resume: vi.fn() };
    const flow = new ConsumerFlowControl(2, 1);
    const paused = new PartitionPauseSet();
    flow.attach(stream);
    stream.resume.mockClear();

    paused.pause('orders', 0);
    expect(stream.pause).not.toHaveBeenCalled();

    // User pause + backpressure + user resume + drain: the partition stays paused,
    // and resuming the partition does not touch the stream's pause reasons.
    flow.setUserPaused(true);
    flow.emitQueued();
    flow.emitQueued();
    flow.emitQueued();
    flow.setUserPaused(false);
    expect(flow.streamPaused).toBe(true);
    flow.emitSettled();
    flow.emitSettled();
    expect(flow.streamPaused).toBe(false);
    expect(paused.isPaused('orders', 0)).toBe(true);

    flow.setUserPaused(true);
    paused.resume('orders', 0);
    expect(flow.streamPaused).toBe(true);
    expect(flow.userPaused).toBe(true);
  });

  it('round-trips partition keys and rejects malformed ones', () => {
    expect(partitionKey('a.b-c', 3)).toBe('a.b-c:3');
    expect(parsePartitionKey('a.b-c:3')).toEqual({ topic: 'a.b-c', partition: 3 });
    expect(parsePartitionKey(':3')).toBeUndefined();
    expect(parsePartitionKey('orders')).toBeUndefined();
    expect(parsePartitionKey('orders:x')).toBeUndefined();
    expect(parsePartitionKey('orders:-1')).toBeUndefined();
  });
});
