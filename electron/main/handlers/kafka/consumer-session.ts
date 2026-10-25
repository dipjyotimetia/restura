import type * as KafkaLib from '@platformatic/kafka';
import type { ConsumerFlowControl } from './consumer-flow';
import {
  DEFAULT_AUTO_COMMIT_INTERVAL_MS,
  DeliveredOffsetCommitter,
} from './delivered-offset-committer';
import { OrderedDelivery } from './ordered-delivery';
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
}

export interface ConsumerStreamHooks {
  /**
   * Decode and send one record; must not emit once `signal` is aborted.
   * Resolving `false` means it was not sent, so its offset is never committed.
   */
  deliver: (msg: SessionMessage, signal: AbortSignal) => Promise<boolean | void>;
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
  readonly #delivery: OrderedDelivery<SessionMessage>;
  readonly partitions = new PartitionPauseSet();
  #exclusive: Promise<unknown> = Promise.resolve();
  #entry: ConsumerSessionEntry | undefined;
  #committer: DeliveredOffsetCommitter | undefined;
  /** Partitions positioned by the last swap; undefined while the stream runs in its subscribe mode. */
  #positioned: Set<string> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  /** Bumped on every group join; a delivery queued under an older assignment never commits. */
  #assignmentGeneration = 0;
  /** Bumped by every successful stream swap. */
  #streamGeneration = 0;
  /**
   * Partition key → stream generation of its last seek. A delivery queued under
   * an older generation is a pre-seek record and must not move the commit.
   */
  readonly #soughtAt = new Map<string, number>();

  constructor(
    private readonly options: ConsumerSessionOptions,
    private readonly hooks: ConsumerStreamHooks
  ) {
    this.#delivery = new OrderedDelivery(hooks.deliver, hooks.onError, options.decodeTimeoutMs);
  }

  /** Whole-stream pause reasons + backpressure of the ordered decode/emit queue. */
  get flow(): ConsumerFlowControl {
    return this.#delivery.flow;
  }

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
      const generation = this.#assignmentGeneration;
      const streamGeneration = this.#streamGeneration;
      this.#delivery.enqueue(msg, () => this.#delivered(msg, generation, streamGeneration));
    });
    stream.on('error', (err: Error) => {
      if (entry.stream === stream) this.hooks.onError(err);
    });
    stream.on('close', () => {
      if (entry.stream === stream) this.hooks.onClose();
    });
    this.flow.attach(stream);
  }

  /**
   * Stop background work and commit what was delivered. Call before closing the
   * stream. Queued records get up to `drainMs` to reach the renderer (0 = abort
   * them at once); only records actually sent are in the final commit. A second
   * call with `drainMs` 0 cuts a pending drain short.
   */
  close(drainMs = 0): Promise<void> {
    const draining = this.#delivery.close(drainMs);
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#entry?.consumer?.removeListener('consumer:group:join', this.#onGroupJoin);
    this.#closing = draining.then(() => this.#committer?.close());
    return this.#closing;
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
      if (entry.stream === old && entry.session === this && !this.#closed) this.flow.attach(old);
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
    this.#streamGeneration += 1;
    for (const key of overrides.keys()) this.#soughtAt.set(key, this.#streamGeneration);
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

  /** A record reached the renderer: record its position unless it was fenced meanwhile. */
  #delivered(msg: SessionMessage, generation: number, streamGeneration: number): void {
    // A rebalance since this record was queued may have revoked its partition.
    if (generation !== this.#assignmentGeneration) return;
    // A record from before a seek of its partition: the seek, not this record,
    // defines the position (the seek target itself is never committed undelivered).
    const sought = this.#soughtAt.get(partitionKey(msg.topic, msg.partition));
    if (sought !== undefined && streamGeneration < sought) return;
    this.#committer?.delivered(msg.topic, msg.partition, msg.offset, msg.leaderEpoch ?? -1);
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
    const { starts, missing } = await this.#startPositions(consumer, added);
    if (missing && this.options.fallback === 'fail') {
      // Same contract as the library's COMMITTED + FAIL mode: no silent jump to a watermark.
      entry.stream?.destroy(
        new Error(
          `Topic ${missing.topic} has no committed offset on partition ${missing.partition} and the fallback mode is "fail".`
        )
      );
      return;
    }
    await this.reposition(entry, () => starts);
  }

  /** Committed offsets for newly assigned partitions, or the fallback when none exists. */
  async #startPositions(
    consumer: SessionConsumer,
    keys: string[]
  ): Promise<{ starts: Map<string, bigint>; missing?: { topic: string; partition: number } }> {
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
    if (missing.length > 0 && this.options.fallback === 'fail') {
      return { starts, ...(missing[0] ? { missing: missing[0] } : {}) };
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
    return { starts };
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
