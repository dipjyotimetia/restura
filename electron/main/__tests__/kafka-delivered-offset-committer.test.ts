// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveredOffsetCommitter } from '../handlers/kafka/delivered-offset-committer';

describe('DeliveredOffsetCommitter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits offset + 1 of the last delivered record per partition on the interval', async () => {
    const commit = vi.fn(async () => {});
    const committer = new DeliveredOffsetCommitter(commit, 1_000, vi.fn());
    committer.delivered('orders', 0, 4n, 3);
    committer.delivered('orders', 0, 5n, 3);
    committer.delivered('orders', 1, 9n, 2);
    expect(commit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith([
      { topic: 'orders', partition: 0, offset: 6n, leaderEpoch: 3 },
      { topic: 'orders', partition: 1, offset: 10n, leaderEpoch: 2 },
    ]);

    // Nothing new delivered → nothing committed.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(commit).toHaveBeenCalledTimes(1);
    await committer.close();
  });

  it('is last-write-wins, so a backward seek commits the lower position', async () => {
    const commit = vi.fn(async () => {});
    const committer = new DeliveredOffsetCommitter(commit, 1_000, vi.fn());
    committer.delivered('orders', 0, 50n, 0);
    committer.delivered('orders', 0, 2n, 0);
    await committer.close();
    expect(commit).toHaveBeenCalledWith([
      { topic: 'orders', partition: 0, offset: 3n, leaderEpoch: 0 },
    ]);
  });

  it('flushes on close and stops the interval', async () => {
    const commit = vi.fn(async () => {});
    const committer = new DeliveredOffsetCommitter(commit, 1_000, vi.fn());
    committer.delivered('orders', 0, 1n, 0);
    await committer.close();
    expect(commit).toHaveBeenCalledTimes(1);
    committer.delivered('orders', 0, 2n, 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('re-queues a failed commit (unless superseded) and reports one error per failure streak', async () => {
    const commit = vi
      .fn<(offsets: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('coordinator moved'))
      .mockRejectedValueOnce(new Error('coordinator moved'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const committer = new DeliveredOffsetCommitter(commit, 1_000, onError);
    committer.delivered('orders', 0, 1n, 0);
    committer.delivered('orders', 1, 1n, 0);
    await committer.flush();
    committer.delivered('orders', 1, 7n, 0); // newer than the failed snapshot
    await committer.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].message).toBe('Offset commit failed: coordinator moved');
    await committer.flush();
    expect(commit).toHaveBeenLastCalledWith([
      { topic: 'orders', partition: 0, offset: 2n, leaderEpoch: 0 },
      { topic: 'orders', partition: 1, offset: 8n, leaderEpoch: 0 },
    ]);
    await committer.close();
  });

  it('drops (does not retry) positions for partitions not owned at flush time', async () => {
    const commit = vi.fn(async () => {});
    let owned = new Set(['orders:0']);
    const committer = new DeliveredOffsetCommitter(commit, 1_000, vi.fn(), () => owned);
    committer.delivered('orders', 1, 1n, 0);
    await committer.flush();
    expect(commit).not.toHaveBeenCalled();
    owned = new Set(['orders:0', 'orders:1']);
    await committer.close();
    expect(commit).not.toHaveBeenCalled();
  });

  it('drops queued positions for revoked partitions', async () => {
    const commit = vi.fn(async () => {});
    const committer = new DeliveredOffsetCommitter(commit, 1_000, vi.fn());
    committer.delivered('orders', 0, 1n, 0);
    committer.delivered('orders', 1, 1n, 0);
    committer.retain(new Set(['orders:1']));
    await committer.close();
    expect(commit).toHaveBeenCalledWith([
      { topic: 'orders', partition: 1, offset: 2n, leaderEpoch: 0 },
    ]);
  });
});
