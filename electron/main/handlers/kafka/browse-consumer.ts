/**
 * Read-only "Browse topic" consumption (#930, #980): stream records without
 * joining or creating a consumer group and without committing offsets.
 *
 * @platformatic/kafka has no group-less consume(): `Consumer.consume()` always
 * joins the group first. It does, however, expose the two group-free
 * primitives a manual `assign()` needs — `listOffsets()` (ListOffsets) and
 * `fetch()` (Metadata + Fetch against the partition leader, with fetch
 * sessions, preferred read replicas and read_committed filtering). This module
 * drives those directly: start positions come from ListOffsets, and a small
 * fetch loop feeds a Readable that is a drop-in for the library's
 * MessagesStream as far as the handler is concerned (data/error/close events,
 * pause/resume, close()).
 *
 * The Consumer still needs a `groupId` to construct, so it gets a placeholder
 * that is never sent: no FindCoordinator/JoinGroup/OffsetCommit request is
 * issued because consume(), commit(), joinGroup() and lag monitoring (which
 * reads committed offsets) are never called, and the classic protocol's
 * close() only sends LeaveGroup after a successful join.
 */
import { Readable } from 'node:stream';
import type * as KafkaLib from '@platformatic/kafka';
import type { KafkaSubscribeConfig } from '../../ipc/ipc-validators';
import type { KafkaClientOptions } from './client-options';

type Consumer = KafkaLib.Consumer<Buffer, Buffer, Buffer, Buffer>;
type ConsumerOptions = KafkaLib.ConsumerOptions<Buffer, Buffer, Buffer, Buffer>;
type Offsets = KafkaLib.Offsets;
type OffsetsWithTimestamps = KafkaLib.OffsetsWithTimestamps;
type FetchRequestTopic = KafkaLib.FetchOptions<Buffer, Buffer, Buffer, Buffer>['topics'][number];

/** Required by the Consumer constructor; never reaches a broker (see above). */
export const BROWSE_PLACEHOLDER_GROUP_ID = '__restura_browse_no_group__';

/** Kafka's own default `max.partition.fetch.bytes`. */
const DEFAULT_PARTITION_MAX_BYTES = 1_048_576;
/** Back-off while every assigned partition is leaderless (e.g. mid-election). */
const NO_LEADER_RETRY_MS = 250;
const IS_CONTROL_BATCH = 1 << 5;
const LIST_OFFSETS_EARLIEST = -2n;
const LIST_OFFSETS_LATEST = -1n;

/** The group-free subset of the Consumer API the browse path is allowed to touch. */
export type BrowseConsumer = Pick<
  Consumer,
  'listOffsets' | 'listOffsetsWithTimestamps' | 'metadata' | 'fetch'
> & { topics: Pick<Consumer['topics'], 'trackAll'> };

export interface PartitionPosition {
  topic: string;
  partition: number;
  offset: bigint;
}

export type BrowseStartSpec =
  | { kind: 'earliest' }
  | { kind: 'latest' }
  | { kind: 'last-n'; count: bigint }
  | { kind: 'timestamp'; timestamp: bigint }
  | { kind: 'offsets'; offsets: PartitionPosition[] };

export function browseStartFromConfig(cfg: KafkaSubscribeConfig): BrowseStartSpec {
  switch (cfg.mode) {
    case 'earliest':
      return { kind: 'earliest' };
    case 'latest':
      return { kind: 'latest' };
    case 'last-n':
      return { kind: 'last-n', count: BigInt(cfg.lastN ?? 0) };
    case 'timestamp':
      return { kind: 'timestamp', timestamp: BigInt(cfg.timestamp ?? '0') };
    case 'manual':
      return {
        kind: 'offsets',
        offsets: (cfg.offsets ?? []).map((o) => ({
          topic: o.topic,
          partition: o.partition,
          offset: BigInt(o.offset),
        })),
      };
    default:
      throw new Error('Browse mode has no consumer group, so it cannot start from committed.');
  }
}

const clamp = (value: bigint, lo: bigint, hi: bigint): bigint =>
  value < lo ? lo : value > hi ? hi : value;

/**
 * Pure start-position computation. `latest` is the next offset to be written
 * (the high watermark, or the LSO under read_committed), so "last N" is
 * `max(earliest, latest - N)` and an empty partition starts — and waits — at
 * `latest`. A timestamp with no record at/after it (offset -1) also waits at
 * `latest`. Explicit offsets assign only the listed partitions and are clamped
 * into the retained range so a stale offset can't trip OFFSET_OUT_OF_RANGE.
 */
export function computeBrowseStartPositions(
  spec: BrowseStartSpec,
  ctx: { earliest: Offsets; latest: Offsets; atTimestamp?: OffsetsWithTimestamps }
): PartitionPosition[] {
  const bounds = (topic: string, partition: number): [bigint, bigint] | undefined => {
    const lo = ctx.earliest.get(topic)?.[partition];
    const hi = ctx.latest.get(topic)?.[partition];
    return lo === undefined || hi === undefined ? undefined : [lo, hi];
  };

  if (spec.kind === 'offsets') {
    return spec.offsets.map(({ topic, partition, offset }) => {
      const range = bounds(topic, partition);
      if (!range) throw new Error(`Topic ${topic} has no partition ${partition}.`);
      return { topic, partition, offset: clamp(offset, range[0], range[1]) };
    });
  }

  const positions: PartitionPosition[] = [];
  for (const [topic, latest] of ctx.latest) {
    latest.forEach((_, partition) => {
      const range = bounds(topic, partition);
      if (!range) return;
      const [lo, hi] = range;
      let offset: bigint;
      if (spec.kind === 'earliest') offset = lo;
      else if (spec.kind === 'latest') offset = hi;
      else if (spec.kind === 'last-n') offset = clamp(hi - spec.count, lo, hi);
      else {
        const resolved = ctx.atTimestamp?.get(topic)?.get(partition)?.offset;
        offset = resolved === undefined || resolved < 0n ? hi : clamp(resolved, lo, hi);
      }
      positions.push({ topic, partition, offset });
    });
  }
  return positions;
}

export function browseConsumerOptions(
  clientOptions: KafkaClientOptions,
  cfg: KafkaSubscribeConfig
): ConsumerOptions {
  return {
    ...clientOptions,
    groupId: BROWSE_PLACEHOLDER_GROUP_ID,
    autocommit: false,
    isolationLevel: cfg.isolation === 'read-committed' ? 1 : 0,
    ...(cfg.minBytes !== undefined ? { minBytes: cfg.minBytes } : {}),
    ...(cfg.maxBytes !== undefined ? { maxBytes: cfg.maxBytes } : {}),
    ...(cfg.maxWaitTimeMs !== undefined ? { maxWaitTime: cfg.maxWaitTimeMs } : {}),
  } as ConsumerOptions;
}

export interface BrowseStreamOptions {
  maxMessages?: number;
  partitionMaxBytes?: number;
  highWaterMark?: number;
}

const neverCommits = (): Promise<void> =>
  Promise.reject(new Error('Browse mode never commits offsets.'));

/**
 * Group-less fetch loop exposed as an object-mode Readable. Readable supplies
 * pause/resume and backpressure: a round that fills the buffer stops the loop
 * until `_read()` asks for more.
 */
export class BrowseMessagesStream extends Readable {
  readonly #consumer: BrowseConsumer;
  readonly #positions = new Map<string, PartitionPosition>();
  readonly #maxMessages: number | undefined;
  readonly #partitionMaxBytes: number;
  #delivered = 0;
  #inflight = false;
  #stopped = false;

  constructor(
    consumer: BrowseConsumer,
    positions: PartitionPosition[],
    options: BrowseStreamOptions = {}
  ) {
    super({ objectMode: true, highWaterMark: options.highWaterMark ?? 1024 });
    this.#consumer = consumer;
    for (const p of positions) this.#positions.set(`${p.topic}:${p.partition}`, { ...p });
    this.#maxMessages = options.maxMessages;
    this.#partitionMaxBytes = options.partitionMaxBytes ?? DEFAULT_PARTITION_MAX_BYTES;
  }

  /** Current next-offset per assigned partition. */
  positions(): PartitionPosition[] {
    return Array.from(this.#positions.values(), (p) => ({ ...p }));
  }

  override _read(): void {
    this.#schedule();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#stopped = true;
    callback(error);
  }

  /** Mirrors MessagesStream.close(); the owning Consumer is closed separately. */
  close(): Promise<void> {
    this.#stopped = true;
    if (!this.destroyed) this.destroy();
    return Promise.resolve();
  }

  #schedule(): void {
    if (this.#inflight || this.#stopped) return;
    this.#inflight = true;
    this.#round().then(
      (continueNow) => {
        this.#inflight = false;
        if (continueNow) setImmediate(() => this.#schedule());
      },
      (error: unknown) => {
        this.#inflight = false;
        if (!this.#stopped) this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    );
  }

  /** One fetch per leader. Resolves true when the loop should run again immediately. */
  async #round(): Promise<boolean> {
    const topics = Array.from(new Set(Array.from(this.#positions.values(), (p) => p.topic)));
    const metadata = await this.#consumer.metadata({ topics });
    if (this.#stopped) return false;

    const byNode = new Map<number, Map<string, FetchRequestTopic>>();
    const topicNames = new Map<string, string>();
    for (const position of this.#positions.values()) {
      const topicMeta = metadata.topics.get(position.topic);
      const leader = topicMeta?.partitions[position.partition]?.leader;
      if (!topicMeta || leader === undefined || leader < 0) continue;
      topicNames.set(topicMeta.id, position.topic);
      let nodeTopics = byNode.get(leader);
      if (!nodeTopics) byNode.set(leader, (nodeTopics = new Map()));
      let request = nodeTopics.get(topicMeta.id);
      if (!request)
        nodeTopics.set(topicMeta.id, (request = { topicId: topicMeta.id, partitions: [] }));
      request.partitions.push({
        partition: position.partition,
        fetchOffset: position.offset,
        currentLeaderEpoch: -1,
        lastFetchedEpoch: -1,
        partitionMaxBytes: this.#partitionMaxBytes,
      });
    }
    if (byNode.size === 0) {
      await new Promise((resolve) => setTimeout(resolve, NO_LEADER_RETRY_MS));
      return !this.#stopped;
    }

    const responses = await Promise.all(
      Array.from(byNode, ([node, nodeTopics]) =>
        this.#consumer.fetch({ node, topics: Array.from(nodeTopics.values()) })
      )
    );
    if (this.#stopped) return false;

    let canPush = true;
    for (const response of responses) {
      for (const topicResponse of response.responses) {
        const topic = topicNames.get(topicResponse.topicId) ?? topicResponse.topicId;
        for (const { partitionIndex, records } of topicResponse.partitions) {
          const position = this.#positions.get(`${topic}:${partitionIndex}`);
          if (!position || !records) continue;
          for (const batch of records) {
            const nextOffset = batch.firstOffset + BigInt(batch.lastOffsetDelta) + 1n;
            if (!(batch.attributes & IS_CONTROL_BATCH)) {
              for (const record of batch.records) {
                const offset = batch.firstOffset + BigInt(record.offsetDelta);
                if (offset < position.offset) continue;
                canPush = this.push({
                  topic,
                  partition: partitionIndex,
                  offset,
                  key: record.key ?? undefined,
                  value: record.value ?? undefined,
                  headers: new Map(
                    record.headers.map(([k, v]) => [k ?? Buffer.alloc(0), v ?? Buffer.alloc(0)])
                  ),
                  timestamp: batch.firstTimestamp + record.timestampDelta,
                  leaderEpoch: batch.partitionLeaderEpoch,
                  commit: neverCommits,
                });
                position.offset = offset + 1n;
                if (this.#maxMessages !== undefined && ++this.#delivered >= this.#maxMessages) {
                  this.#stopped = true;
                  this.push(null);
                  return false;
                }
              }
            }
            if (nextOffset > position.offset) position.offset = nextOffset;
          }
        }
      }
    }
    return canPush;
  }
}

/**
 * Assigns every partition of `cfg.topics` (or only the listed ones for explicit
 * offsets), resolves the start positions via ListOffsets, and returns a stream
 * that starts fetching once it is read.
 */
export async function openBrowseStream(
  consumer: BrowseConsumer,
  cfg: KafkaSubscribeConfig
): Promise<BrowseMessagesStream> {
  const spec = browseStartFromConfig(cfg);
  const topics = cfg.topics;
  // Tracked topics drive the Consumer's own metadata refresh inside fetch().
  consumer.topics.trackAll(...topics);
  const [earliest, latest, atTimestamp] = await Promise.all([
    consumer.listOffsets({ topics, timestamp: LIST_OFFSETS_EARLIEST }),
    consumer.listOffsets({ topics, timestamp: LIST_OFFSETS_LATEST }),
    spec.kind === 'timestamp'
      ? consumer.listOffsetsWithTimestamps({ topics, timestamp: spec.timestamp })
      : undefined,
  ]);
  const positions = computeBrowseStartPositions(spec, {
    earliest,
    latest,
    ...(atTimestamp ? { atTimestamp } : {}),
  });
  if (positions.length === 0) throw new Error('No partitions to browse on the selected topic(s).');
  return new BrowseMessagesStream(consumer, positions, {
    ...(cfg.maxMessages !== undefined ? { maxMessages: cfg.maxMessages } : {}),
    ...(cfg.highWaterMark !== undefined ? { highWaterMark: cfg.highWaterMark } : {}),
    partitionMaxBytes: cfg.maxBytesPerPartition ?? cfg.maxBytes ?? DEFAULT_PARTITION_MAX_BYTES,
  });
}
