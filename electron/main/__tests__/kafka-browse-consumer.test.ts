// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  BROWSE_PLACEHOLDER_GROUP_ID,
  type BrowseConsumer,
  BrowseMessagesStream,
  browseConsumerOptions,
  browseStartFromConfig,
  computeBrowseStartPositions,
  openBrowseStream,
} from '../handlers/kafka/browse-consumer';
import { KafkaSubscribeSchema } from '../ipc/ipc-validators';

const offsets = (entries: Record<string, number[]>) =>
  new Map(Object.entries(entries).map(([topic, list]) => [topic, list.map(BigInt)]));

const browseCfg = (extra: Record<string, unknown> = {}) =>
  KafkaSubscribeSchema.parse({
    connectionId: 'c',
    membership: 'browse',
    topics: ['orders'],
    mode: 'earliest',
    ...extra,
  });

describe('computeBrowseStartPositions', () => {
  // Partition 0 has records 10..99 (latest = next offset = 100); partition 1 is
  // empty at 5 (earliest == latest); partition 2 holds 0..2.
  const earliest = offsets({ orders: [10, 5, 0] });
  const latest = offsets({ orders: [100, 5, 3] });
  const positions = (spec: Parameters<typeof computeBrowseStartPositions>[0], extra = {}) =>
    computeBrowseStartPositions(spec, { earliest, latest, ...extra }).map(
      (p) => `${p.topic}/${p.partition}@${p.offset}`
    );

  it('assigns every partition at earliest or latest', () => {
    expect(positions({ kind: 'earliest' })).toEqual(['orders/0@10', 'orders/1@5', 'orders/2@0']);
    expect(positions({ kind: 'latest' })).toEqual(['orders/0@100', 'orders/1@5', 'orders/2@3']);
  });

  it('starts last-N at max(earliest, latest - N) per partition', () => {
    // p0: 100-5=95; p1: empty stays at 5; p2: 3-5=-2 clamps to earliest 0.
    expect(positions({ kind: 'last-n', count: 5n })).toEqual([
      'orders/0@95',
      'orders/1@5',
      'orders/2@0',
    ]);
    // Larger than retained history clamps to earliest, not below it.
    expect(positions({ kind: 'last-n', count: 1000n })).toEqual([
      'orders/0@10',
      'orders/1@5',
      'orders/2@0',
    ]);
  });

  it('resolves timestamps, falling back to latest when no record is at/after it (-1)', () => {
    const atTimestamp = new Map([
      [
        'orders',
        new Map([
          [0, { offset: 42n, timestamp: 1n }],
          [1, { offset: -1n, timestamp: -1n }],
        ]),
      ],
    ]);
    // p2 is missing from the response entirely: also treated as "nothing yet".
    expect(positions({ kind: 'timestamp', timestamp: 1n }, { atTimestamp })).toEqual([
      'orders/0@42',
      'orders/1@5',
      'orders/2@3',
    ]);
  });

  it('assigns only the listed partitions for explicit offsets, clamped into range', () => {
    expect(
      positions({
        kind: 'offsets',
        offsets: [
          { topic: 'orders', partition: 0, offset: 50n },
          { topic: 'orders', partition: 2, offset: 999n },
        ],
      })
    ).toEqual(['orders/0@50', 'orders/2@3']);
    expect(
      positions({ kind: 'offsets', offsets: [{ topic: 'orders', partition: 0, offset: 1n }] })
    ).toEqual(['orders/0@10']);
  });

  it('rejects an explicit offset on a partition the topic does not have', () => {
    expect(() =>
      positions({ kind: 'offsets', offsets: [{ topic: 'orders', partition: 7, offset: 0n }] })
    ).toThrow(/partition 7/i);
  });
});

describe('browseStartFromConfig', () => {
  it('maps every browse start position', () => {
    expect(browseStartFromConfig(browseCfg())).toEqual({ kind: 'earliest' });
    expect(browseStartFromConfig(browseCfg({ mode: 'latest' }))).toEqual({ kind: 'latest' });
    expect(browseStartFromConfig(browseCfg({ mode: 'last-n', lastN: 20 }))).toEqual({
      kind: 'last-n',
      count: 20n,
    });
    expect(
      browseStartFromConfig(browseCfg({ mode: 'timestamp', timestamp: '1718800000000' }))
    ).toEqual({ kind: 'timestamp', timestamp: 1718800000000n });
    expect(
      browseStartFromConfig(
        browseCfg({ mode: 'manual', offsets: [{ topic: 'orders', partition: 1, offset: '9' }] })
      )
    ).toEqual({ kind: 'offsets', offsets: [{ topic: 'orders', partition: 1, offset: 9n }] });
  });

  it('refuses committed — browse has no group to have committed for', () => {
    const cfg = { ...browseCfg(), mode: 'committed' as const };
    expect(() => browseStartFromConfig(cfg)).toThrow(/committed/);
  });
});

describe('browseConsumerOptions', () => {
  it('disables autocommit, keeps the classic protocol and never names a real group', () => {
    const options = browseConsumerOptions(
      { clientId: 'restura-x', bootstrapBrokers: ['b:9092'] },
      browseCfg({ isolation: 'read-committed', maxWaitTimeMs: 250, minBytes: 1, maxBytes: 2048 })
    ) as unknown as Record<string, unknown>;
    expect(options).toMatchObject({
      clientId: 'restura-x',
      bootstrapBrokers: ['b:9092'],
      groupId: BROWSE_PLACEHOLDER_GROUP_ID,
      autocommit: false,
      isolationLevel: 1,
      maxWaitTime: 250,
      minBytes: 1,
      maxBytes: 2048,
    });
    // The consumer protocol's close() always sends a leave heartbeat; classic
    // (the default when unset) only leaves when it actually joined.
    expect(options.groupProtocol).toBeUndefined();
    expect(BROWSE_PLACEHOLDER_GROUP_ID.startsWith('restura-')).toBe(false);
  });

  it('clamps a zero long-poll so an idle browse cannot hammer the broker', () => {
    const options = browseConsumerOptions(
      { clientId: 'c', bootstrapBrokers: ['b:9092'] },
      browseCfg({ maxWaitTimeMs: 0, minBytes: 0 })
    ) as unknown as Record<string, unknown>;
    expect(options.maxWaitTime).toBe(100);
  });
});

// --- Fetch loop ------------------------------------------------------------

interface FakeRecord {
  offsetDelta: number;
  value?: string | null;
  key?: string | null;
  headers?: [string, string][];
  timestampDelta?: number;
}
interface FakeBatch {
  firstOffset: number;
  lastOffsetDelta: number;
  control?: boolean;
  records: FakeRecord[];
}

function batch(firstOffset: number, values: string[], control = false): FakeBatch {
  return {
    firstOffset,
    lastOffsetDelta: values.length - 1,
    control,
    records: values.map((value, index) => ({ offsetDelta: index, value })),
  };
}

type FetchPlan = Record<string, Record<number, FakeBatch[]>>;
/** Plan entry: a response, a thrown error, or a long-poll that never returns. */
type PlanStep = FetchPlan | Error | typeof HANG;
const HANG = Symbol('hang');

const outOfRange = () =>
  Object.assign(new Error('Fetch failed'), {
    errors: [Object.assign(new Error('Offset out of range'), { apiId: 'OFFSET_OUT_OF_RANGE' })],
  });

/** A consumer that only exposes the group-less surface the browse loop may use. */
function fakeConsumer(
  fetchPlan: PlanStep[],
  meta: Record<string, { id: string; leaders: number[] }> = {
    orders: { id: 'id-orders', leaders: [1, 2] },
  },
  /** Per-leader queues; a node without one falls back to the shared `fetchPlan`. */
  nodePlans: Record<number, PlanStep[]> = {}
) {
  const fetchCalls: Array<{ node: number; topics: unknown }> = [];
  const forbidden = {
    consume: vi.fn(),
    commit: vi.fn(),
    joinGroup: vi.fn(),
    startLagMonitoring: vi.fn(),
    listCommittedOffsets: vi.fn(),
    findGroupCoordinator: vi.fn(),
  };
  const tracked: string[] = [];
  const consumer = {
    ...forbidden,
    topics: { trackAll: vi.fn((...topics: string[]) => tracked.push(...topics)) },
    listOffsets: vi.fn(async ({ timestamp }: { timestamp: bigint }) =>
      timestamp === -2n ? offsets({ orders: [0, 0] }) : offsets({ orders: [10, 10] })
    ),
    listOffsetsWithTimestamps: vi.fn(async () => new Map()),
    metadata: vi.fn(async () => ({
      topics: new Map(
        Object.entries(meta).map(([name, { id, leaders }]) => [
          name,
          {
            id,
            partitionsCount: leaders.length,
            partitions: leaders.map((leader) => ({ leader, leaderEpoch: 0 })),
          },
        ])
      ),
    })),
    fetch: vi.fn(
      async (options: {
        node: number;
        topics: Array<{ topicId: string; partitions: Array<{ partition: number }> }>;
      }) => {
        fetchCalls.push({ node: options.node, topics: options.topics });
        const step = (nodePlans[options.node] ?? fetchPlan).shift() ?? {};
        if (step === HANG) await new Promise(() => {});
        if (step instanceof Error) throw step;
        const plan = step as FetchPlan;
        return {
          responses: options.topics.map((topic) => {
            const name =
              Object.entries(meta).find(([, value]) => value.id === topic.topicId)?.[0] ?? '';
            return {
              topicId: topic.topicId,
              partitions: topic.partitions.map(({ partition }) => ({
                partitionIndex: partition,
                lastStableOffset: 0n,
                records: (plan[name]?.[partition] ?? []).map((b) => ({
                  firstOffset: BigInt(b.firstOffset),
                  lastOffsetDelta: b.lastOffsetDelta,
                  firstTimestamp: 1_000n,
                  attributes: b.control ? 1 << 5 : 0,
                  records: b.records.map((r) => ({
                    offsetDelta: r.offsetDelta,
                    timestampDelta: BigInt(r.timestampDelta ?? 0),
                    key: r.key == null ? null : Buffer.from(r.key),
                    value: r.value == null ? null : Buffer.from(r.value),
                    headers: (r.headers ?? []).map(([k, v]) => [Buffer.from(k), Buffer.from(v)]),
                  })),
                })),
              })),
            };
          }),
        };
      }
    ),
  };
  return { consumer, forbidden, fetchCalls, tracked };
}

type Collected = { topic: string; partition: number; offset: bigint; value?: Buffer };

function collect(stream: BrowseMessagesStream, count: number): Promise<Collected[]> {
  const out: Collected[] = [];
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('data', (msg: Collected) => {
      out.push(msg);
      if (out.length === count) resolve(out);
    });
    stream.on('end', () => resolve(out));
  });
}

describe('BrowseMessagesStream', () => {
  it('fetches each partition from its leader and never touches the group API', async () => {
    const { consumer, forbidden, fetchCalls } = fakeConsumer([
      { orders: { 0: [batch(0, ['a', 'b'])] } },
      { orders: { 1: [batch(3, ['c'])] } },
    ]);
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [
      { topic: 'orders', partition: 0, offset: 0n },
      { topic: 'orders', partition: 1, offset: 3n },
    ]);
    const messages = await collect(stream, 3);
    await stream.close();

    expect(messages.map((m) => `${m.partition}@${m.offset}=${m.value?.toString()}`)).toEqual([
      '0@0=a',
      '0@1=b',
      '1@3=c',
    ]);
    // Partition 0 leads on node 1, partition 1 on node 2: one request each.
    expect(new Set(fetchCalls.slice(0, 2).map((c) => c.node))).toEqual(new Set([1, 2]));
    for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
  });

  it('advances positions, drops records below the position and skips control batches', async () => {
    const { consumer, fetchCalls } = fakeConsumer(
      [
        // A batch can start before the requested offset; 5 and 6 must be dropped.
        { orders: { 0: [batch(5, ['x', 'y', 'z']), batch(8, ['marker'], true)] } },
        { orders: { 0: [batch(9, ['next'])] } },
      ],
      { orders: { id: 'id-orders', leaders: [1] } }
    );
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [
      { topic: 'orders', partition: 0, offset: 7n },
    ]);
    const messages = await collect(stream, 2);
    await stream.close();

    expect(messages.map((m) => `${m.offset}=${m.value?.toString()}`)).toEqual(['7=z', '9=next']);
    const requested = (fetchCalls[1]?.topics as Array<{ partitions: { fetchOffset: bigint }[] }>)[0]
      ?.partitions[0]?.fetchOffset;
    expect(requested).toBe(9n);
  });

  it('maps headers, null keys/values and timestamps onto the consumed-message shape', async () => {
    const { consumer } = fakeConsumer(
      [
        {
          orders: {
            0: [
              {
                firstOffset: 0,
                lastOffsetDelta: 0,
                records: [
                  {
                    offsetDelta: 0,
                    key: 'k',
                    value: null,
                    headers: [['h', 'v']],
                    timestampDelta: 5,
                  },
                ],
              },
            ],
          },
        },
      ],
      { orders: { id: 'id-orders', leaders: [1] } }
    );
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [
      { topic: 'orders', partition: 0, offset: 0n },
    ]);
    const [message] = (await collect(stream, 1)) as unknown as Array<{
      key?: Buffer;
      value?: Buffer;
      headers: Map<Buffer, Buffer>;
      timestamp: bigint;
      commit: () => Promise<void>;
    }>;
    await stream.close();

    expect(message?.key?.toString()).toBe('k');
    expect(message?.value).toBeUndefined();
    expect(Array.from(message?.headers ?? [], ([k, v]) => `${k}=${v}`)).toEqual(['h=v']);
    expect(message?.timestamp).toBe(1_005n);
    await expect(message?.commit()).rejects.toThrow(/never commits/);
  });

  it('ends the stream after maxMessages records', async () => {
    const { consumer } = fakeConsumer(
      [{ orders: { 0: [batch(0, ['a', 'b', 'c'])] } }, { orders: { 0: [batch(3, ['d'])] } }],
      { orders: { id: 'id-orders', leaders: [1] } }
    );
    const stream = new BrowseMessagesStream(
      consumer as unknown as BrowseConsumer,
      [{ topic: 'orders', partition: 0, offset: 0n }],
      { maxMessages: 2 }
    );
    const messages = await collect(stream, 99);
    expect(messages.map((m) => m.value?.toString())).toEqual(['a', 'b']);
    expect(consumer.fetch).toHaveBeenCalledTimes(1);
  });

  it('destroys with the fetch error so the handler can surface it', async () => {
    const { consumer } = fakeConsumer([], { orders: { id: 'id-orders', leaders: [1] } });
    consumer.fetch.mockRejectedValueOnce(new Error('broker down'));
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [
      { topic: 'orders', partition: 0, offset: 0n },
    ]);
    await expect(collect(stream, 1)).rejects.toThrow('broker down');
  });

  it('close() stops the loop and emits close', async () => {
    const { consumer } = fakeConsumer([], { orders: { id: 'id-orders', leaders: [1] } });
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [
      { topic: 'orders', partition: 0, offset: 0n },
    ]);
    const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()));
    stream.resume();
    await stream.close();
    await closed;
    const calls = consumer.fetch.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(consumer.fetch.mock.calls.length).toBe(calls);
  });

  it('waits and retries when no partition currently has a leader', async () => {
    vi.useFakeTimers();
    try {
      const { consumer } = fakeConsumer([], { orders: { id: 'id-orders', leaders: [-1] } });
      const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [
        { topic: 'orders', partition: 0, offset: 0n },
      ]);
      stream.resume();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(consumer.fetch).not.toHaveBeenCalled();
      expect(consumer.metadata.mock.calls.length).toBeGreaterThan(1);
      await stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openBrowseStream', () => {
  it('tracks the topics, resolves start positions with ListOffsets only, and streams', async () => {
    const { consumer, forbidden, tracked } = fakeConsumer(
      [{ orders: { 0: [batch(7, ['p0'])], 1: [batch(7, ['p1'])] } }],
      { orders: { id: 'id-orders', leaders: [1, 1] } }
    );
    const stream = await openBrowseStream(
      consumer as unknown as BrowseConsumer,
      browseCfg({ mode: 'last-n', lastN: 3 })
    );
    const messages = await collect(stream, 2);
    await stream.close();

    expect(tracked).toEqual(['orders']);
    expect(consumer.listOffsets).toHaveBeenCalledWith(
      expect.objectContaining({ topics: ['orders'], timestamp: -2n })
    );
    expect(consumer.listOffsets).toHaveBeenCalledWith(
      expect.objectContaining({ topics: ['orders'], timestamp: -1n })
    );
    expect(consumer.listOffsetsWithTimestamps).not.toHaveBeenCalled();
    expect(messages.map((m) => `${m.partition}@${m.offset}`).sort()).toEqual(['0@7', '1@7']);
    for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
  });

  it('resolves a timestamp start through ListOffsets with that timestamp', async () => {
    const { consumer } = fakeConsumer([]);
    consumer.listOffsetsWithTimestamps.mockResolvedValueOnce(
      new Map([['orders', new Map([[0, { offset: 4n, timestamp: 9n }]])]])
    );
    const stream = await openBrowseStream(
      consumer as unknown as BrowseConsumer,
      browseCfg({ mode: 'timestamp', timestamp: '1718800000000' })
    );
    expect(consumer.listOffsetsWithTimestamps).toHaveBeenCalledWith({
      topics: ['orders'],
      timestamp: 1718800000000n,
    });
    expect(stream.positions()).toEqual([
      { topic: 'orders', partition: 0, offset: 4n },
      { topic: 'orders', partition: 1, offset: 10n },
    ]);
    await stream.close();
  });
});

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};
const single = { orders: { id: 'id-orders', leaders: [1] } };
const at = (partition: number, offset: bigint) => ({ topic: 'orders', partition, offset });

describe('BrowseMessagesStream — hardening', () => {
  it('backs off after empty fetches instead of spinning', async () => {
    vi.useFakeTimers();
    try {
      const { consumer } = fakeConsumer([], single);
      const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [at(0, 0n)]);
      stream.resume();
      await vi.advanceTimersByTimeAsync(1_000);
      // ~one fetch per 200 ms back-off window, not thousands of setImmediate rounds.
      expect(consumer.fetch.mock.calls.length).toBeGreaterThan(1);
      expect(consumer.fetch.mock.calls.length).toBeLessThanOrEqual(7);
      await stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps fetching a busy leader while another leader long-polls', async () => {
    const busy = [0, 1, 2].map((i) => ({ orders: { 1: [batch(i, [`n2-${i}`])] } }));
    const { consumer } = fakeConsumer([], undefined, { 1: [HANG], 2: busy });
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [
      at(0, 0n),
      at(1, 0n),
    ]);
    const messages = await collect(stream, 3);
    await stream.close();
    expect(messages.map((m) => m.value?.toString())).toEqual(['n2-0', 'n2-1', 'n2-2']);
  });

  it('keeps records already received from one leader when another leader fails', async () => {
    const { consumer } = fakeConsumer([]);
    consumer.fetch.mockImplementation(async (options: { node: number }) => {
      if (options.node === 2) {
        await new Promise((r) => setTimeout(r, 30));
        throw new Error('node 2 down');
      }
      return {
        responses: [
          {
            topicId: 'id-orders',
            partitions: [
              {
                partitionIndex: 0,
                lastStableOffset: 0n,
                records: [
                  {
                    firstOffset: 0n,
                    lastOffsetDelta: 0,
                    firstTimestamp: 0n,
                    attributes: 0,
                    records: [
                      {
                        offsetDelta: 0,
                        timestampDelta: 0n,
                        key: null,
                        value: Buffer.from('kept'),
                        headers: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      } as never;
    });
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [
      at(0, 0n),
      at(1, 0n),
    ]);
    const seen: string[] = [];
    const failed = new Promise<Error>((resolve) => stream.once('error', resolve));
    stream.on('data', (m: Collected) => seen.push(m.value?.toString() ?? ''));
    expect((await failed).message).toBe('node 2 down');
    expect(seen).toEqual(['kept']);
  });

  it('re-seeks an out-of-range partition into the retained range and continues', async () => {
    const { consumer } = fakeConsumer(
      [outOfRange(), { orders: { 0: [batch(4, ['after-retention'])] } }],
      single
    );
    // Retention moved the log start to 4 while we were positioned at 1.
    consumer.listOffsets.mockImplementation(async ({ timestamp }: { timestamp: bigint }) =>
      timestamp === -2n ? offsets({ orders: [4] }) : offsets({ orders: [5] })
    );
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [at(0, 1n)]);
    const [message] = await collect(stream, 1);
    await stream.close();
    expect(message?.offset).toBe(4n);
    expect(consumer.listOffsets).toHaveBeenCalledWith(
      expect.objectContaining({ topics: ['orders'], partitions: { orders: [0] } })
    );
  });

  it('stops fetching when the buffer is full and resumes on read', async () => {
    const { consumer } = fakeConsumer(
      [{ orders: { 0: [batch(0, ['a', 'b', 'c'])] } }, { orders: { 0: [batch(3, ['d'])] } }],
      single
    );
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [at(0, 0n)], {
      highWaterMark: 2,
    });
    stream.read(0); // paused mode: start the loop without consuming
    await waitFor(() => stream.readableLength === 3);
    await new Promise((r) => setTimeout(r, 300)); // longer than the empty back-off
    expect(consumer.fetch).toHaveBeenCalledTimes(1);

    const drained = [stream.read(), stream.read(), stream.read()] as Collected[];
    expect(drained.map((m) => m.value?.toString())).toEqual(['a', 'b', 'c']);
    await waitFor(() => consumer.fetch.mock.calls.length >= 2);
    await stream.close();
  });

  it('delivers exactly maxMessages across partitions on different leaders', async () => {
    const { consumer } = fakeConsumer([], undefined, {
      1: [{ orders: { 0: [batch(0, ['p0-0', 'p0-1', 'p0-2'])] } }],
      2: [{ orders: { 1: [batch(0, ['p1-0', 'p1-1', 'p1-2'])] } }],
    });
    const stream = new BrowseMessagesStream(
      consumer as unknown as BrowseConsumer,
      [at(0, 0n), at(1, 0n)],
      { maxMessages: 4 }
    );
    const messages = await collect(stream, 99);
    expect(messages).toHaveLength(4);
    await new Promise((r) => setTimeout(r, 20));
    expect(stream.readableEnded).toBe(true);
    await stream.close();
  });

  it('never pushes a response that lands after close()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { consumer } = fakeConsumer([{ orders: { 0: [batch(0, ['late'])] } }], single);
    const original = consumer.fetch.getMockImplementation()!;
    consumer.fetch.mockImplementation(async (options) => {
      await gate;
      return original(options);
    });
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [at(0, 0n)]);
    const data = vi.fn();
    const error = vi.fn();
    stream.on('data', data);
    stream.on('error', error);
    await waitFor(() => consumer.fetch.mock.calls.length === 1);
    await stream.close();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(data).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('does not end on its own so the owner can flush and close it', async () => {
    const { consumer } = fakeConsumer([{ orders: { 0: [batch(0, ['a'])] } }], single);
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [at(0, 0n)], {
      maxMessages: 1,
    });
    const closed = vi.fn();
    stream.on('close', closed);
    await collect(stream, 99);
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).not.toHaveBeenCalled();
    await stream.close();
    await waitFor(() => closed.mock.calls.length === 1);
  });

  it('advances past a read_committed range whose aborted data was filtered out', async () => {
    // The library drops aborted batches only when their abort marker is in the
    // same response, and keeps that control batch, so the position still moves.
    const { consumer, fetchCalls } = fakeConsumer(
      [
        { orders: { 0: [batch(5, ['abort-marker'], true)] } },
        { orders: { 0: [batch(6, ['committed'])] } },
      ],
      single
    );
    const stream = new BrowseMessagesStream(consumer as unknown as BrowseConsumer, [at(0, 0n)]);
    const [message] = await collect(stream, 1);
    await stream.close();
    expect(message?.offset).toBe(6n);
    const second = (fetchCalls[1]?.topics as Array<{ partitions: { fetchOffset: bigint }[] }>)[0];
    expect(second?.partitions[0]?.fetchOffset).toBe(6n);
  });
});
