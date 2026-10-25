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
import { type DeliverRecord, OrderedDelivery, type QueuedRecord } from './ordered-delivery';
import { partitionKey } from './partition-pause';

type Consumer = KafkaLib.Consumer<Buffer, Buffer, Buffer, Buffer>;
type ConsumerOptions = KafkaLib.ConsumerOptions<Buffer, Buffer, Buffer, Buffer>;
type Offsets = KafkaLib.Offsets;
type OffsetsWithTimestamps = KafkaLib.OffsetsWithTimestamps;
type FetchRequestTopic = KafkaLib.FetchOptions<Buffer, Buffer, Buffer, Buffer>['topics'][number];
type FetchResponse = Awaited<ReturnType<Consumer['fetch']>>;

/** Required by the Consumer constructor; never reaches a broker (see above). */
export const BROWSE_PLACEHOLDER_GROUP_ID = '__restura_browse_no_group__';

/** Kafka's own default `max.partition.fetch.bytes`. */
const DEFAULT_PARTITION_MAX_BYTES = 1_048_576;
/** Back-off while every assigned partition is leaderless (e.g. mid-election). */
const NO_LEADER_RETRY_MS = 250;
/**
 * Leadership moved (election, broker restart). The library already retries
 * most of these with a metadata refresh, but its retries can run out; browsing
 * should outlast an election rather than end the session.
 */
const LEADER_MOVED_ERRORS = [
  'NOT_LEADER_OR_FOLLOWER',
  'FENCED_LEADER_EPOCH',
  'UNKNOWN_LEADER_EPOCH',
  'LEADER_NOT_AVAILABLE',
] as const;
/** Back-off for a leader whose fetch delivered nothing (idle topic, minBytes 0). */
const EMPTY_FETCH_BACKOFF_MS = 200;
/** Floor for the broker long-poll so an idle browse can't hammer the broker. */
const MIN_MAX_WAIT_MS = 100;
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
    ...(cfg.maxWaitTimeMs !== undefined
      ? { maxWaitTime: Math.max(cfg.maxWaitTimeMs, MIN_MAX_WAIT_MS) }
      : {}),
  } as ConsumerOptions;
}

export interface BrowseStreamOptions {
  maxMessages?: number;
  partitionMaxBytes?: number;
  highWaterMark?: number;
}

const neverCommits = (): Promise<void> =>
  Promise.reject(new Error('Browse mode never commits offsets.'));

/** Walks the library's nested error tree (`errors[]` / `cause`) for a broker error code. */
function hasApiError(error: unknown, apiId: string, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const node = error as { apiId?: unknown; errors?: unknown; cause?: unknown };
  if (node.apiId === apiId) return true;
  if (Array.isArray(node.errors) && node.errors.some((e) => hasApiError(e, apiId, seen))) {
    return true;
  }
  return hasApiError(node.cause, apiId, seen);
}

interface NodeRequest {
  topics: FetchRequestTopic[];
  /** topicId → topic name, for decoding the response. */
  names: Map<string, string>;
}

/**
 * Group-less fetch loop exposed as an object-mode Readable, modelled on the
 * library's MessagesStream: each partition leader runs its own fetch loop, so a
 * quiet leader's long-poll never delays (or, on error, discards) another
 * leader's records. A fetch that yields nothing backs that leader off briefly
 * instead of spinning. When `push()` reports a full buffer, no new fetches are
 * issued until `_read()` asks for more.
 *
 * `autoDestroy` is off: after a stop-after-N `end`, the owner flushes the
 * records it is still forwarding and then calls `close()`, so `close` always
 * follows the last record.
 */
export class BrowseMessagesStream extends Readable {
  readonly #consumer: BrowseConsumer;
  readonly #positions = new Map<string, PartitionPosition>();
  readonly #topics: string[];
  readonly #maxMessages: number | undefined;
  readonly #partitionMaxBytes: number;
  readonly #inflightNodes = new Set<number>();
  readonly #backoffs = new Map<number, ReturnType<typeof setTimeout>>();
  #delivered = 0;
  #wantMore = false;
  #planning = false;
  #replan = false;
  #stopped = false;
  #forceMetadata = false;

  constructor(
    consumer: BrowseConsumer,
    positions: PartitionPosition[],
    options: BrowseStreamOptions = {}
  ) {
    super({ objectMode: true, highWaterMark: options.highWaterMark ?? 1024, autoDestroy: false });
    this.#consumer = consumer;
    for (const p of positions) this.#positions.set(partitionKey(p.topic, p.partition), { ...p });
    this.#topics = Array.from(new Set(positions.map((p) => p.topic)));
    this.#maxMessages = options.maxMessages;
    this.#partitionMaxBytes = options.partitionMaxBytes ?? DEFAULT_PARTITION_MAX_BYTES;
  }

  /** Current next-offset per assigned partition. */
  positions(): PartitionPosition[] {
    return Array.from(this.#positions.values(), (p) => ({ ...p }));
  }

  override _read(): void {
    this.#wantMore = true;
    this.#plan();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#stop();
    callback(error);
  }

  /** Mirrors MessagesStream.close(); the owning Consumer is closed separately. */
  close(): Promise<void> {
    this.#stop();
    if (!this.destroyed) this.destroy();
    return Promise.resolve();
  }

  #stop(): void {
    this.#stopped = true;
    for (const timer of this.#backoffs.values()) clearTimeout(timer);
    this.#backoffs.clear();
  }

  #fail(error: unknown): void {
    if (this.#stopped) return;
    this.destroy(error instanceof Error ? error : new Error(String(error)));
  }

  #backoff(node: number, ms: number): void {
    if (this.#stopped || this.#backoffs.has(node)) return;
    this.#backoffs.set(
      node,
      setTimeout(() => {
        this.#backoffs.delete(node);
        this.#plan();
      }, ms)
    );
  }

  /** Starts a fetch for every leader that is neither in flight nor backing off. */
  #plan(): void {
    if (this.#stopped || !this.#wantMore) return;
    if (this.#planning) {
      this.#replan = true;
      return;
    }
    this.#planning = true;
    this.#launch()
      .catch((error: unknown) => this.#fail(error))
      .finally(() => {
        this.#planning = false;
        if (this.#replan) {
          this.#replan = false;
          this.#plan();
        }
      });
  }

  async #launch(): Promise<void> {
    const forceUpdate = this.#forceMetadata;
    this.#forceMetadata = false;
    const metadata = await this.#consumer.metadata({
      topics: this.#topics,
      ...(forceUpdate ? { forceUpdate } : {}),
    });
    if (this.#stopped || !this.#wantMore) return;

    const requests = new Map<number, NodeRequest>();
    for (const position of this.#positions.values()) {
      const topicMeta = metadata.topics.get(position.topic);
      const leader = topicMeta?.partitions[position.partition]?.leader;
      if (!topicMeta || leader === undefined || leader < 0) continue;
      if (this.#inflightNodes.has(leader) || this.#backoffs.has(leader)) continue;
      let request = requests.get(leader);
      if (!request) requests.set(leader, (request = { topics: [], names: new Map() }));
      request.names.set(topicMeta.id, position.topic);
      let topic = request.topics.find((t) => t.topicId === topicMeta.id);
      if (!topic) request.topics.push((topic = { topicId: topicMeta.id, partitions: [] }));
      topic.partitions.push({
        partition: position.partition,
        fetchOffset: position.offset,
        currentLeaderEpoch: -1,
        lastFetchedEpoch: -1,
        partitionMaxBytes: this.#partitionMaxBytes,
      });
    }
    for (const [node, request] of requests) this.#fetchNode(node, request);
    // Every partition is leaderless right now (e.g. mid-election): look again shortly.
    if (this.#inflightNodes.size === 0 && this.#backoffs.size === 0) {
      this.#backoff(-1, NO_LEADER_RETRY_MS);
    }
  }

  #fetchNode(node: number, request: NodeRequest): void {
    this.#inflightNodes.add(node);
    this.#consumer.fetch({ node, topics: request.topics }).then(
      (response) => {
        this.#inflightNodes.delete(node);
        if (this.#stopped) return;
        const pushed = this.#ingest(response, request.names);
        if (this.#stopped) return;
        if (pushed === 0) this.#backoff(node, EMPTY_FETCH_BACKOFF_MS);
        else this.#plan();
      },
      (error: unknown) => {
        if (!this.#stopped && LEADER_MOVED_ERRORS.some((id) => hasApiError(error, id))) {
          // Re-resolve the leader before this node's partitions are fetched again.
          this.#inflightNodes.delete(node);
          this.#forceMetadata = true;
          this.#backoff(node, NO_LEADER_RETRY_MS);
          return;
        }
        if (this.#stopped || !hasApiError(error, 'OFFSET_OUT_OF_RANGE')) {
          this.#inflightNodes.delete(node);
          this.#fail(error);
          return;
        }
        // Retention (or truncation) moved the log under us: clamp and carry on.
        // The node stays "in flight" so no fetch races the re-seek.
        this.#reseek(request).then(
          () => {
            this.#inflightNodes.delete(node);
            this.#plan();
          },
          (reseekError: unknown) => {
            this.#inflightNodes.delete(node);
            this.#fail(reseekError);
          }
        );
      }
    );
  }

  /** Clamps every partition of a failed request into its current retained range. */
  async #reseek(request: NodeRequest): Promise<void> {
    const partitions: Record<string, number[]> = {};
    for (const topic of request.topics) {
      const name = request.names.get(topic.topicId) ?? topic.topicId;
      partitions[name] = topic.partitions.map((p) => p.partition);
    }
    const topics = Object.keys(partitions);
    const [earliest, latest] = await Promise.all([
      this.#consumer.listOffsets({ topics, partitions, timestamp: LIST_OFFSETS_EARLIEST }),
      this.#consumer.listOffsets({ topics, partitions, timestamp: LIST_OFFSETS_LATEST }),
    ]);
    for (const [topic, list] of Object.entries(partitions)) {
      for (const partition of list) {
        const position = this.#positions.get(partitionKey(topic, partition));
        const lo = earliest.get(topic)?.[partition];
        const hi = latest.get(topic)?.[partition];
        if (position && lo !== undefined && hi !== undefined) {
          position.offset = clamp(position.offset, lo, hi);
        }
      }
    }
  }

  /** Pushes one leader's records; returns how many were delivered. */
  #ingest(response: FetchResponse, names: Map<string, string>): number {
    let pushed = 0;
    for (const topicResponse of response.responses) {
      const topic = names.get(topicResponse.topicId) ?? topicResponse.topicId;
      for (const { partitionIndex, records } of topicResponse.partitions) {
        const position = this.#positions.get(partitionKey(topic, partitionIndex));
        if (!position || !records) continue;
        for (const batch of records) {
          const nextOffset = batch.firstOffset + BigInt(batch.lastOffsetDelta) + 1n;
          if (!(batch.attributes & IS_CONTROL_BATCH)) {
            for (const record of batch.records) {
              const offset = batch.firstOffset + BigInt(record.offsetDelta);
              if (offset < position.offset) continue;
              const hasRoom = this.push({
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
              if (!hasRoom) this.#wantMore = false;
              pushed++;
              position.offset = offset + 1n;
              if (this.#maxMessages !== undefined && ++this.#delivered >= this.#maxMessages) {
                this.#stop();
                this.push(null);
                return pushed;
              }
            }
          }
          if (nextOffset > position.offset) position.offset = nextOffset;
        }
      }
    }
    return pushed;
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

/**
 * Calls `release` once when the stream ends (stop-after-N) or closes (fetch
 * error, destroy), so the owner can forward queued records and then free the
 * consumer slot.
 */
export function onBrowseStreamFinished(stream: BrowseMessagesStream, release: () => void): void {
  let released = false;
  const once = (): void => {
    if (released) return;
    released = true;
    release();
  };
  stream.once('end', once);
  stream.once('close', once);
}

/** The stream surface browse delivery binds to (BrowseMessagesStream or a test double). */
type BrowseEventStream = Pick<Readable, 'on' | 'pause' | 'resume'>;

/**
 * Binds browse-mode delivery to `stream`: records flow through the same ordered
 * decode/emit queue as group sessions — paused past the high-water mark, hung
 * decodes skipped after the decode timeout, and aborted by `close()` so nothing
 * queued is decoded or sent after unsubscribe/disconnect.
 */
export function bindBrowseDelivery<M extends QueuedRecord>(
  stream: BrowseEventStream,
  hooks: { deliver: DeliverRecord<M>; onError: (err: Error) => void; onClose: () => void }
): OrderedDelivery<M> {
  const delivery = new OrderedDelivery<M>(hooks.deliver, hooks.onError);
  stream.on('data', (msg: M) => delivery.enqueue(msg));
  stream.on('error', (err: Error) => hooks.onError(err));
  stream.on('close', () => hooks.onClose());
  // After the data listener: resuming without one would drop records.
  delivery.flow.attach(stream);
  return delivery;
}
