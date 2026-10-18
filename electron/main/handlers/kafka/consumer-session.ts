import type * as KafkaLib from '@platformatic/kafka';
import { ConsumerFlowControl } from './consumer-flow';
import {
  DEFAULT_AUTO_COMMIT_INTERVAL_MS,
  DeliveredOffsetCommitter,
} from './delivered-offset-committer';
import { PartitionPauseSet, parsePartitionKey, partitionKey } from './partition-pause';

type SessionConsumer = KafkaLib.Consumer<Buffer, Buffer, Buffer, Buffer>;
type SessionStream = KafkaLib.MessagesStream<Buffer, Buffer, Buffer, Buffer>;
type SessionMessage = KafkaLib.Message<Buffer, Buffer, Buffer, Buffer>;
export type ConsumerFallback = 'latest' | 'earliest' | 'fail';

/** The slice of a live Kafka connection a consumer session drives. */
export interface ConsumerSessionEntry {
  consumer?: SessionConsumer;
  stream?: SessionStream;
  session?: KafkaConsumerSession;
  /** Serializes async decode/emission in arrival order. */
  emitChain: Promise<void>;
}

export interface ConsumerStreamHooks {
  /** Decode and send one record; must not emit once `signal` is aborted. */
  deliver: (msg: SessionMessage, signal: AbortSignal) => Promise<void>;
  onError: (err: Error) => void;
  onClose: () => void;
}

export interface ConsumerSessionOptions {
  topics: readonly string[];
  kafka: typeof KafkaLib;
  /** Where partitions without a committed offset start (subscribe's fallback mode). */
  fallback?: ConsumerFallback;
  /** Commit delivered positions on this interval; omit for manual per-message commits. */
  autoCommitIntervalMs?: number;
  /** Upper bound on opening a replacement stream (seek / partition resume / rebalance). */
  swapTimeoutMs?: number;
  /** Upper bound on decoding + sending one record before it is skipped. */
  decodeTimeoutMs?: number;
}

const DEFAULT_SWAP_TIMEOUT_MS = 30_000;
const DEFAULT_DECODE_TIMEOUT_MS = 30_000;

/** Library fallback-mode value for the subscribe-time fallback string. */
export function fallbackModeValue(
  kafka: typeof KafkaLib,
  fallback: ConsumerFallback | undefined
): KafkaLib.MessagesStreamFallbackModeValue | undefined {
  if (!fallback) return undefined;
  const modes = kafka.MessagesStreamFallbackModes;
  return fallback === 'earliest' ? modes.EARLIEST : fallback === 'fail' ? modes.FAIL : modes.LATEST;
}

/** `topic:partition` keys assigned to this member, or undefined before the first assignment. */
export function assignedKeys(consumer: SessionConsumer): Set<string> | undefined {
  const assignments = consumer.assignments;
  if (!assignments) return undefined;
  const keys = new Set<string>();
  for (const { topic, partitions } of assignments) {
    for (const partition of partitions) keys.add(partitionKey(topic, partition));
  }
  return keys;
}

/**
 * Runtime state of one subscription's consumer stream: whole-stream pause
 * reasons + backpressure (#938), emulated partition pause and live seek (#942),
 * and automatic commits of delivered positions.
 *
 * Seek and partition resume reposition the stream. @platformatic/kafka (2.14)
 * has no mid-stream seek: the stream's own `offsetsToFetch` map is overwritten
 * by in-flight fetch responses and reset by group rejoins. The supported way is
 * the public `consumer.consume({ mode: MANUAL, offsets })`, so a reposition
 * swaps the stream:
 *  1. pause the old stream and drain what it already buffered through the
 *     normal listener, so nothing fetched before the seek is lost;
 *  2. snapshot its next-fetch offsets for the partitions currently assigned to
 *     this member and apply the overrides;
 *  3. open the replacement in MANUAL mode *before* closing the old one — the
 *     topics stay tracked, so the consumer does not rejoin its group;
 *  4. bind the replacement, hand it the current pause reasons, close the old.
 * A MANUAL stream would keep stale positions across a rebalance, so after a
 * swap every group join repositions newly assigned partitions to the group's
 * committed offset (or the fallback), keeping explicit positions only for
 * partitions this member still owns.
 */
export class KafkaConsumerSession {
  readonly flow = new ConsumerFlowControl();
  readonly partitions = new PartitionPauseSet();
  #exclusive: Promise<unknown> = Promise.resolve();
  #entry: ConsumerSessionEntry | undefined;
  #committer: DeliveredOffsetCommitter | undefined;
  /** Partitions positioned by the last swap; undefined while the stream runs in its subscribe mode. */
  #positioned: Set<string> | undefined;
  #closed = false;
  /** Bumped on every group join; a delivery queued under an older assignment never commits. */
  #assignmentGeneration = 0;

  constructor(
    private readonly options: ConsumerSessionOptions,
    private readonly hooks: ConsumerStreamHooks
  ) {}

  get topics(): readonly string[] {
    return this.options.topics;
  }

  /** Make `stream` the entry's live stream: listeners, gating, and pause state. */
  bind(entry: ConsumerSessionEntry, stream: SessionStream): void {
    if (!this.#entry) this.#start(entry);
    entry.stream = stream;
    stream.on('data', (msg: SessionMessage) => {
      if (entry.stream !== stream) return;
      // Paused partitions are withheld before decode, never queue an emit and never commit.
      if (!this.partitions.admit(msg.topic, msg.partition, msg.offset)) return;
      this.flow.emitQueued();
      const generation = this.#assignmentGeneration;
      // One bad decode must not wedge the ordered emission chain.
      entry.emitChain = entry.emitChain
        .then(() => this.#deliver(msg, generation))
        .catch(() => {})
        .finally(() => this.flow.emitSettled());
    });
    stream.on('error', (err: Error) => {
      if (entry.stream === stream) this.hooks.onError(err);
    });
    stream.on('close', () => {
      if (entry.stream === stream) this.hooks.onClose();
    });
    this.flow.attach(stream);
  }

  /** Stop background work and commit what was delivered. Call before closing the stream. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#entry?.consumer?.removeListener('consumer:group:join', this.#onGroupJoin);
    this.flow.detach();
    await this.#committer?.close();
  }

  /** Serialize repositioning so two seeks/resumes never swap streams concurrently. */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#exclusive.then(task, task);
    this.#exclusive = run.catch(() => {});
    return run;
  }

  /**
   * Swap in a MANUAL-mode stream positioned at the old stream's next-fetch
   * offsets, with the planned overrides (partition key → offset) applied on top.
   * `plan` runs after the old stream's buffer is drained, so partition-pause
   * bookkeeping it reads (rewind points) already reflects every fetched record.
   * An empty plan keeps the old stream. Throws when there is no live stream, the
   * swap times out, or the consumer went away mid-swap.
   */
  async reposition(
    entry: ConsumerSessionEntry,
    plan: () => ReadonlyMap<string, bigint>
  ): Promise<void> {
    const { consumer, stream: old } = entry;
    if (!consumer || !old || entry.session !== this || this.#closed) {
      throw new Error('No consumer is active.');
    }

    this.flow.detach();
    old.pause();
    // Readable#read emits 'data' to the bound listener for each buffered record.
    while (old.read() !== null) {
      /* drained through the listener */
    }
    const overrides = plan();
    if (overrides.size === 0) {
      this.flow.attach(old);
      return;
    }

    const assigned = assignedKeys(consumer);
    const positions = new Map(old.offsetsToFetch);
    for (const [key, offset] of overrides) positions.set(key, offset);
    const offsets: KafkaLib.TopicWithPartitionAndOffset[] = [];
    for (const [key, offset] of positions) {
      const tp = parsePartitionKey(key);
      if (!tp || !this.topics.includes(tp.topic)) continue;
      // Only partitions this member owns; others belong to the next rebalance.
      if (assigned && !assigned.has(key)) continue;
      offsets.push({ ...tp, offset });
    }

    await this.#committer?.flush();
    const fallbackMode = fallbackModeValue(this.options.kafka, this.options.fallback);
    const opening = consumer.consume({
      topics: [...this.topics],
      mode: this.options.kafka.MessagesStreamModes.MANUAL,
      offsets,
      ...(fallbackMode ? { fallbackMode } : {}),
    }) as Promise<SessionStream>;
    let next: SessionStream;
    try {
      next = await withTimeout(
        opening,
        this.options.swapTimeoutMs ?? DEFAULT_SWAP_TIMEOUT_MS,
        'Repositioning the consumer timed out.'
      );
    } catch (err) {
      // A replacement that shows up after the timeout must not leak.
      opening.then(closeQuietly, () => {});
      if (entry.stream === old && entry.session === this) this.flow.attach(old);
      throw err;
    }
    if (
      this.#closed ||
      entry.stream !== old ||
      entry.consumer !== consumer ||
      entry.session !== this
    ) {
      await closeQuietly(next);
      throw new Error('The consumer was closed while repositioning.');
    }
    this.#positioned = new Set(offsets.map((o) => partitionKey(o.topic, o.partition)));
    this.bind(entry, next);
    await closeQuietly(old);
  }

  #start(entry: ConsumerSessionEntry): void {
    this.#entry = entry;
    const consumer = entry.consumer;
    if (!consumer) return;
    consumer.on('consumer:group:join', this.#onGroupJoin);
    if (this.options.autoCommitIntervalMs !== undefined) {
      this.#committer = new DeliveredOffsetCommitter(
        (offsets) => consumer.commit({ offsets }),
        this.options.autoCommitIntervalMs,
        this.hooks.onError,
        () => assignedKeys(consumer)
      );
    }
  }

  async #deliver(msg: SessionMessage, generation: number): Promise<void> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve('timeout');
      }, this.options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([
        this.hooks.deliver(msg, abort.signal).then(() => 'delivered' as const),
        timeout,
      ]);
      if (outcome === 'delivered') {
        // A rebalance since this record was queued may have revoked its partition.
        if (generation !== this.#assignmentGeneration) return;
        this.#committer?.delivered(msg.topic, msg.partition, msg.offset, msg.leaderEpoch ?? -1);
      } else {
        this.hooks.onError(
          new Error(
            `Decoding ${msg.topic}[${msg.partition}]@${msg.offset} timed out; the record was skipped.`
          )
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #onGroupJoin = (): void => {
    this.#assignmentGeneration += 1;
    void this.runExclusive(() => this.#rebalanced()).catch((err: unknown) => {
      this.hooks.onError(err instanceof Error ? err : new Error(String(err)));
    });
  };

  async #rebalanced(): Promise<void> {
    const entry = this.#entry;
    const consumer = entry?.consumer;
    if (!entry || !consumer || entry.session !== this || this.#closed) return;
    const assigned = assignedKeys(consumer);
    if (!assigned) return;
    this.partitions.retain(assigned);
    this.#committer?.retain(assigned);
    // Before any swap the library's own subscribe mode restores positions itself.
    const positioned = this.#positioned;
    if (!positioned) return;
    const added = [...assigned].filter((key) => !positioned.has(key));
    if (added.length === 0) {
      this.#positioned = assigned;
      return;
    }
    const starts = await this.#startPositions(consumer, added);
    await this.reposition(entry, () => starts);
  }

  /** Committed offsets for newly assigned partitions, or the fallback when none exists. */
  async #startPositions(consumer: SessionConsumer, keys: string[]): Promise<Map<string, bigint>> {
    const byTopic = new Map<string, number[]>();
    for (const key of keys) {
      const tp = parsePartitionKey(key);
      if (!tp) continue;
      byTopic.set(tp.topic, [...(byTopic.get(tp.topic) ?? []), tp.partition]);
    }
    const topics = [...byTopic].map(([topic, partitions]) => ({ topic, partitions }));
    const committed = await consumer.listCommittedOffsets({ topics });
    const starts = new Map<string, bigint>();
    const missing: Array<{ topic: string; partition: number }> = [];
    for (const { topic, partitions } of topics) {
      for (const partition of partitions) {
        const offset = committed.get(topic)?.[partition];
        if (typeof offset === 'bigint' && offset >= 0n)
          starts.set(partitionKey(topic, partition), offset);
        else missing.push({ topic, partition });
      }
    }
    if (missing.length > 0) {
      const timestamps = this.options.kafka.ListOffsetTimestamps;
      const fallback = await consumer.listOffsets({
        topics: [...new Set(missing.map((m) => m.topic))],
        partitions: Object.fromEntries(
          [...new Set(missing.map((m) => m.topic))].map((t) => [
            t,
            missing.filter((m) => m.topic === t).map((m) => m.partition),
          ])
        ),
        timestamp: this.options.fallback === 'earliest' ? timestamps.EARLIEST : timestamps.LATEST,
      });
      for (const { topic, partition } of missing) {
        const offset = fallback.get(topic)?.[partition];
        if (typeof offset === 'bigint' && offset >= 0n)
          starts.set(partitionKey(topic, partition), offset);
      }
    }
    return starts;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function closeQuietly(stream: SessionStream): Promise<void> {
  try {
    await Promise.resolve(stream.close());
  } catch {
    /* best effort — the replacement is already live */
  }
}

/** Session for a validated subscribe request (auto commits unless the policy is manual). */
export function subscriptionSession(
  cfg: {
    topics: string[];
    fallbackMode?: ConsumerFallback;
    commitPolicy?: 'auto' | 'manual';
    autoCommitIntervalMs?: number;
  },
  kafka: typeof KafkaLib,
  hooks: ConsumerStreamHooks
): KafkaConsumerSession {
  return new KafkaConsumerSession(
    {
      topics: cfg.topics,
      kafka,
      ...(cfg.fallbackMode ? { fallback: cfg.fallbackMode } : {}),
      ...(cfg.commitPolicy === 'manual'
        ? {}
        : { autoCommitIntervalMs: cfg.autoCommitIntervalMs ?? DEFAULT_AUTO_COMMIT_INTERVAL_MS }),
    },
    hooks
  );
}
