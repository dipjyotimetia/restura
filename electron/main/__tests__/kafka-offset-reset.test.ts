import { describe, expect, it, vi } from 'vitest';
import {
  assertGroupInactive,
  clampShift,
  deleteGroupOffsets,
  type OffsetAdmin,
  resetGroupOffsets,
} from '../handlers/kafka/offset-reset';
import { KafkaDeleteGroupOffsetsSchema, KafkaResetGroupOffsetsSchema } from '../ipc/ipc-validators';

const EARLIEST = -2n;
const LATEST = -1n;
const TIMESTAMPS = { EARLIEST, LATEST };

type Watermarks = Record<string, Record<number, { earliest: bigint; latest: bigint }>>;

interface FakeOpts {
  state?: string;
  members?: number;
  partitions?: Record<string, number>;
  committed?: Record<string, Record<number, bigint>>;
  watermarks?: Watermarks;
  /** offsets returned for a positive timestamp lookup, per topic/partition (-1n = none). */
  byTimestamp?: Record<string, Record<number, bigint>>;
}

function fakeAdmin(opts: FakeOpts = {}) {
  const watermarks = opts.watermarks ?? {};
  const admin = {
    describeGroups: vi.fn(async ({ groups }: { groups: string[] }) => {
      const id = groups[0]!;
      const members = new Map(
        Array.from({ length: opts.members ?? 0 }, (_, i) => [`m${i}`, { id: `m${i}` }])
      );
      return new Map([[id, { id, state: opts.state ?? 'EMPTY', members }]]);
    }),
    listConsumerGroupOffsets: vi.fn(async ({ groups }: { groups: { groupId: string }[] }) => [
      {
        groupId: groups[0]!.groupId,
        topics: Object.entries(opts.committed ?? {}).map(([name, parts]) => ({
          name,
          partitions: Object.entries(parts).map(([p, committedOffset]) => ({
            partitionIndex: Number(p),
            committedOffset,
          })),
        })),
      },
    ]),
    metadata: vi.fn(async ({ topics }: { topics: string[] }) => ({
      topics: new Map(
        topics
          .filter((t) => opts.partitions?.[t] !== undefined)
          .map((t) => [t, { partitionsCount: opts.partitions![t]! }])
      ),
    })),
    listOffsets: vi.fn(
      async ({
        topics,
      }: {
        topics: { name: string; partitions: { partitionIndex: number; timestamp: bigint }[] }[];
      }) =>
        topics.map((topic) => ({
          name: topic.name,
          partitions: topic.partitions.map(({ partitionIndex, timestamp }) => {
            const marks = watermarks[topic.name]?.[partitionIndex] ?? { earliest: 0n, latest: 0n };
            const offset =
              timestamp === EARLIEST
                ? marks.earliest
                : timestamp === LATEST
                  ? marks.latest
                  : (opts.byTimestamp?.[topic.name]?.[partitionIndex] ?? -1n);
            return { partitionIndex, offset, timestamp, leaderEpoch: 0 };
          }),
        }))
    ),
    alterConsumerGroupOffsets: vi.fn(async () => undefined),
    deleteConsumerGroupOffsets: vi.fn(
      async ({ topics }: { topics: { name: string; partitionIndexes: number[] }[] }) => topics
    ),
  };
  return admin as typeof admin & OffsetAdmin;
}

const base = { connectionId: 'c', groupId: 'g' } as const;

describe('Kafka offset reset — schema', () => {
  const ok = (v: object) => KafkaResetGroupOffsetsSchema.safeParse({ ...base, ...v }).success;

  it('accepts the new targets with their required values', () => {
    expect(ok({ topic: 'orders', to: 'timestamp', timestamp: 1_700_000_000_000 })).toBe(true);
    expect(ok({ topic: 'orders', to: 'shift', shift: -10 })).toBe(true);
    expect(ok({ allTopics: true, to: 'earliest' })).toBe(true);
    expect(ok({ allTopics: true, to: 'shift', shift: 5, dryRun: true })).toBe(true);
  });

  it('rejects timestamp without a value and shift without an amount', () => {
    expect(ok({ topic: 'orders', to: 'timestamp' })).toBe(false);
    expect(ok({ topic: 'orders', to: 'shift' })).toBe(false);
  });

  it('rejects non-integer / out-of-range values', () => {
    expect(ok({ topic: 'orders', to: 'shift', shift: 1.5 })).toBe(false);
    expect(ok({ topic: 'orders', to: 'timestamp', timestamp: -1 })).toBe(false);
    expect(ok({ topic: 'orders', to: 'timestamp', timestamp: 8_640_000_000_000_001 })).toBe(false);
  });

  it('requires exactly one of topic / allTopics', () => {
    expect(ok({ to: 'latest' })).toBe(false);
    expect(ok({ allTopics: false, to: 'latest' })).toBe(false);
    expect(ok({ topic: 'orders', allTopics: true, to: 'latest' })).toBe(false);
  });

  it('rejects allTopics with specific offsets', () => {
    expect(
      ok({ allTopics: true, to: 'specific', partitions: [{ partition: 0, offset: '1' }] })
    ).toBe(false);
  });

  it('validates delete-offsets scope', () => {
    const del = (v: object) => KafkaDeleteGroupOffsetsSchema.safeParse({ ...base, ...v }).success;
    expect(del({ topic: 'orders' })).toBe(true);
    expect(del({ topic: 'orders', partitions: [0, 2] })).toBe(true);
    expect(del({ allTopics: true })).toBe(true);
    expect(del({})).toBe(false);
    expect(del({ allTopics: true, topic: 'orders' })).toBe(false);
    expect(del({ allTopics: true, partitions: [0] })).toBe(false);
    expect(del({ topic: 'orders', partitions: [-1] })).toBe(false);
    expect(del({ topic: 'orders', partitions: [] })).toBe(false);
  });
});

describe('clampShift', () => {
  it('moves within range without a note', () => {
    expect(clampShift(50n, -10n, 0n, 100n)).toEqual({ offset: 40n });
  });
  it('clamps below the earliest offset', () => {
    expect(clampShift(5n, -10n, 3n, 100n)).toEqual({ offset: 3n, note: 'clamped-earliest' });
  });
  it('clamps above the latest offset', () => {
    expect(clampShift(95n, 10n, 0n, 100n)).toEqual({ offset: 100n, note: 'clamped-latest' });
  });
});

describe('assertGroupInactive', () => {
  it('passes for an empty or dead group', async () => {
    await expect(assertGroupInactive(fakeAdmin({ state: 'EMPTY' }), 'g', 'reset')).resolves.toBe(
      undefined
    );
    await expect(assertGroupInactive(fakeAdmin({ state: 'Dead' }), 'g', 'reset')).resolves.toBe(
      undefined
    );
  });
  it('rejects a group with active members', async () => {
    await expect(
      assertGroupInactive(fakeAdmin({ state: 'STABLE', members: 2 }), 'g', 'reset offsets for')
    ).rejects.toThrow(/2 active member/);
  });
  it('rejects a rebalancing group even without listed members', async () => {
    await expect(
      assertGroupInactive(fakeAdmin({ state: 'PreparingRebalance' }), 'g', 'reset')
    ).rejects.toThrow(/PreparingRebalance/);
  });
});

describe('resetGroupOffsets', () => {
  const watermarks: Watermarks = {
    orders: { 0: { earliest: 10n, latest: 100n }, 1: { earliest: 0n, latest: 40n } },
    audit: { 0: { earliest: 0n, latest: 7n } },
  };

  it('resets one topic to earliest across every partition and commits it', async () => {
    const admin = fakeAdmin({
      partitions: { orders: 2 },
      committed: { orders: { 0: 50n } },
      watermarks,
    });
    const result = await resetGroupOffsets(admin, TIMESTAMPS, {
      ...base,
      topic: 'orders',
      to: 'earliest',
    });
    expect(result.offsets).toEqual([
      { topic: 'orders', partition: 0, previous: '50', offset: '10' },
      { topic: 'orders', partition: 1, previous: null, offset: '0' },
    ]);
    expect(result.dryRun).toBe(false);
    expect(admin.alterConsumerGroupOffsets).toHaveBeenCalledWith({
      groupId: 'g',
      topics: [
        {
          name: 'orders',
          partitionOffsets: [
            { partition: 0, offset: 10n },
            { partition: 1, offset: 0n },
          ],
        },
      ],
    });
  });

  it('throws when a single topic has no partitions', async () => {
    const admin = fakeAdmin({ partitions: {} });
    await expect(
      resetGroupOffsets(admin, TIMESTAMPS, { ...base, topic: 'missing', to: 'latest' })
    ).rejects.toThrow(/no partitions or does not exist/);
  });

  it('resolves a timestamp via ListOffsets and falls back to latest when no offset exists', async () => {
    const admin = fakeAdmin({
      partitions: { orders: 2 },
      watermarks,
      byTimestamp: { orders: { 0: 42n, 1: -1n } },
    });
    const result = await resetGroupOffsets(admin, TIMESTAMPS, {
      ...base,
      topic: 'orders',
      to: 'timestamp',
      timestamp: 1_700_000_000_000,
    });
    expect(admin.listOffsets).toHaveBeenCalledWith({
      topics: [
        {
          name: 'orders',
          partitions: [
            { partitionIndex: 0, timestamp: 1_700_000_000_000n },
            { partitionIndex: 1, timestamp: 1_700_000_000_000n },
          ],
        },
      ],
    });
    expect(result.offsets).toEqual([
      { topic: 'orders', partition: 0, previous: null, offset: '42' },
      {
        topic: 'orders',
        partition: 1,
        previous: null,
        offset: '40',
        note: 'timestamp-fallback-latest',
      },
    ]);
  });

  it('shifts committed offsets, clamps both ends and skips uncommitted partitions', async () => {
    const admin = fakeAdmin({
      partitions: { orders: 2 },
      committed: { orders: { 0: 15n } },
      watermarks,
    });
    const back = await resetGroupOffsets(admin, TIMESTAMPS, {
      ...base,
      topic: 'orders',
      to: 'shift',
      shift: -20,
    });
    expect(back.offsets).toEqual([
      { topic: 'orders', partition: 0, previous: '15', offset: '10', note: 'clamped-earliest' },
    ]);
    expect(back.skipped).toEqual([
      { topic: 'orders', partition: 1, reason: 'no-committed-offset' },
    ]);

    const forward = await resetGroupOffsets(admin, TIMESTAMPS, {
      ...base,
      topic: 'orders',
      to: 'shift',
      shift: 1000,
    });
    expect(forward.offsets[0]).toEqual({
      topic: 'orders',
      partition: 0,
      previous: '15',
      offset: '100',
      note: 'clamped-latest',
    });
  });

  it('errors when a shift has nothing committed to move', async () => {
    const admin = fakeAdmin({ partitions: { orders: 2 }, watermarks });
    await expect(
      resetGroupOffsets(admin, TIMESTAMPS, { ...base, topic: 'orders', to: 'shift', shift: 1 })
    ).rejects.toThrow(/no committed offsets/i);
    expect(admin.alterConsumerGroupOffsets).not.toHaveBeenCalled();
  });

  it('expands allTopics to every committed topic/partition', async () => {
    const admin = fakeAdmin({
      committed: { orders: { 0: 50n, 1: -1n }, audit: { 0: 3n } },
      watermarks,
    });
    const result = await resetGroupOffsets(admin, TIMESTAMPS, {
      ...base,
      allTopics: true,
      to: 'latest',
    });
    expect(admin.metadata).not.toHaveBeenCalled();
    expect(result.offsets).toEqual([
      { topic: 'audit', partition: 0, previous: '3', offset: '7' },
      { topic: 'orders', partition: 0, previous: '50', offset: '100' },
    ]);
    expect(admin.alterConsumerGroupOffsets).toHaveBeenCalledWith({
      groupId: 'g',
      topics: [
        { name: 'audit', partitionOffsets: [{ partition: 0, offset: 7n }] },
        { name: 'orders', partitionOffsets: [{ partition: 0, offset: 100n }] },
      ],
    });
  });

  it('errors for allTopics when the group has no committed offsets', async () => {
    await expect(
      resetGroupOffsets(fakeAdmin(), TIMESTAMPS, { ...base, allTopics: true, to: 'earliest' })
    ).rejects.toThrow(/no committed offsets/i);
  });

  it('passes specific offsets through with previous values', async () => {
    const admin = fakeAdmin({ committed: { orders: { 0: 5n } } });
    const result = await resetGroupOffsets(admin, TIMESTAMPS, {
      ...base,
      topic: 'orders',
      to: 'specific',
      partitions: [{ partition: 0, offset: '3' }],
    });
    expect(result.offsets).toEqual([{ topic: 'orders', partition: 0, previous: '5', offset: '3' }]);
    expect(admin.listOffsets).not.toHaveBeenCalled();
  });

  it('dry run returns the plan without committing or checking membership', async () => {
    const admin = fakeAdmin({ state: 'STABLE', members: 1, partitions: { orders: 1 }, watermarks });
    const result = await resetGroupOffsets(admin, TIMESTAMPS, {
      ...base,
      topic: 'orders',
      to: 'latest',
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.offsets).toEqual([
      { topic: 'orders', partition: 0, previous: null, offset: '100' },
    ]);
    expect(admin.alterConsumerGroupOffsets).not.toHaveBeenCalled();
    expect(admin.describeGroups).not.toHaveBeenCalled();
  });

  it('refuses to reset an active group', async () => {
    const admin = fakeAdmin({ state: 'STABLE', members: 1, partitions: { orders: 1 }, watermarks });
    await expect(
      resetGroupOffsets(admin, TIMESTAMPS, { ...base, topic: 'orders', to: 'latest' })
    ).rejects.toThrow(/active member/);
    expect(admin.alterConsumerGroupOffsets).not.toHaveBeenCalled();
  });
});

describe('deleteGroupOffsets', () => {
  it('deletes every committed partition of a topic', async () => {
    const admin = fakeAdmin({ committed: { orders: { 0: 1n, 1: 2n, 2: -1n } } });
    const result = await deleteGroupOffsets(admin, { ...base, topic: 'orders' });
    expect(admin.deleteConsumerGroupOffsets).toHaveBeenCalledWith({
      groupId: 'g',
      topics: [{ name: 'orders', partitionIndexes: [0, 1] }],
    });
    expect(result.deleted).toEqual([{ topic: 'orders', partitions: [0, 1] }]);
  });

  it('honours an explicit partition subset', async () => {
    const admin = fakeAdmin({ committed: { orders: { 0: 1n, 1: 2n } } });
    await deleteGroupOffsets(admin, { ...base, topic: 'orders', partitions: [1] });
    expect(admin.deleteConsumerGroupOffsets).toHaveBeenCalledWith({
      groupId: 'g',
      topics: [{ name: 'orders', partitionIndexes: [1] }],
    });
  });

  it('expands allTopics to every committed topic', async () => {
    const admin = fakeAdmin({ committed: { orders: { 0: 1n }, audit: { 0: 4n, 1: 5n } } });
    await deleteGroupOffsets(admin, { ...base, allTopics: true });
    expect(admin.deleteConsumerGroupOffsets).toHaveBeenCalledWith({
      groupId: 'g',
      topics: [
        { name: 'audit', partitionIndexes: [0, 1] },
        { name: 'orders', partitionIndexes: [0] },
      ],
    });
  });

  it('errors when there is nothing committed to delete', async () => {
    const admin = fakeAdmin();
    await expect(deleteGroupOffsets(admin, { ...base, topic: 'orders' })).rejects.toThrow(
      /no committed offsets/i
    );
    expect(admin.deleteConsumerGroupOffsets).not.toHaveBeenCalled();
  });

  it('refuses to delete offsets of an active group', async () => {
    const admin = fakeAdmin({ state: 'STABLE', members: 3, committed: { orders: { 0: 1n } } });
    await expect(deleteGroupOffsets(admin, { ...base, topic: 'orders' })).rejects.toThrow(
      /active member/
    );
    expect(admin.deleteConsumerGroupOffsets).not.toHaveBeenCalled();
  });
});
