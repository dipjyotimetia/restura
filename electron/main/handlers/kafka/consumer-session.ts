import type * as KafkaLib from '@platformatic/kafka';
import { ConsumerFlowControl } from './consumer-flow';
import { PartitionPauseSet, parsePartitionKey } from './partition-pause';

type SessionConsumer = KafkaLib.Consumer<Buffer, Buffer, Buffer, Buffer>;
type SessionStream = KafkaLib.MessagesStream<Buffer, Buffer, Buffer, Buffer>;
type SessionMessage = KafkaLib.Message<Buffer, Buffer, Buffer, Buffer>;

/** The slice of a live Kafka connection a consumer session drives. */
export interface ConsumerSessionEntry {
  consumer?: SessionConsumer;
  stream?: SessionStream;
  session?: KafkaConsumerSession;
  /** Serializes async decode/emission in arrival order. */
  emitChain: Promise<void>;
}

export interface ConsumerStreamHooks {
  /** Decode and send one record to the renderer. */
  deliver: (msg: SessionMessage) => Promise<void>;
  onError: (err: Error) => void;
  onClose: () => void;
}

/**
 * Runtime state of one subscription's consumer stream: whole-stream pause
 * reasons + backpressure (#938), emulated partition pause and live seek (#942).
 *
 * Seek and partition resume reposition the stream. @platformatic/kafka (2.14)
 * has no mid-stream seek: the stream's own `offsetsToFetch` map is overwritten
 * by in-flight fetch responses and reset by group rejoins. The supported way is
 * the public `consumer.consume({ mode: MANUAL, offsets })`, so a reposition
 * swaps the stream:
 *  1. pause the old stream and drain what it already buffered through the
 *     normal listener, so nothing fetched before the seek is lost;
 *  2. snapshot its per-partition next-fetch offsets and apply the overrides;
 *  3. open the replacement in MANUAL mode *before* closing the old one — the
 *     topics stay tracked, so the consumer does not rejoin its group;
 *  4. bind the replacement, hand it the current pause reasons, close the old.
 * Afterwards the stream runs in MANUAL mode: a later group rebalance keeps the
 * known positions instead of re-reading the group's committed offsets.
 */
export class KafkaConsumerSession {
  readonly flow = new ConsumerFlowControl();
  readonly partitions = new PartitionPauseSet();
  #exclusive: Promise<unknown> = Promise.resolve();

  constructor(
    readonly topics: readonly string[],
    private readonly hooks: ConsumerStreamHooks
  ) {}

  /** Make `stream` the entry's live stream: listeners, gating, and pause state. */
  bind(entry: ConsumerSessionEntry, stream: SessionStream): void {
    entry.stream = stream;
    stream.on('data', (msg: SessionMessage) => {
      if (entry.stream !== stream) return;
      // Paused partitions are withheld before decode and never queue an emit.
      if (!this.partitions.admit(msg.topic, msg.partition, msg.offset)) return;
      this.flow.emitQueued();
      // One bad decode must not wedge the ordered emission chain.
      entry.emitChain = entry.emitChain
        .then(() => this.hooks.deliver(msg))
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
   * An empty plan keeps the old stream. Throws when there is no live stream or
   * the consumer went away mid-swap.
   */
  async reposition(
    entry: ConsumerSessionEntry,
    plan: () => ReadonlyMap<string, bigint>,
    manualMode: KafkaLib.MessagesStreamModeValue
  ): Promise<void> {
    const { consumer, stream: old } = entry;
    if (!consumer || !old || entry.session !== this) throw new Error('No consumer is active.');

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

    const positions = new Map(old.offsetsToFetch);
    for (const [key, offset] of overrides) positions.set(key, offset);
    const offsets: KafkaLib.TopicWithPartitionAndOffset[] = [];
    for (const [key, offset] of positions) {
      const tp = parsePartitionKey(key);
      if (tp && this.topics.includes(tp.topic)) offsets.push({ ...tp, offset });
    }

    let next: SessionStream;
    try {
      next = (await consumer.consume({
        topics: [...this.topics],
        mode: manualMode,
        offsets,
      })) as SessionStream;
    } catch (err) {
      if (entry.stream === old && entry.session === this) this.flow.attach(old);
      throw err;
    }
    if (entry.stream !== old || entry.consumer !== consumer || entry.session !== this) {
      await closeQuietly(next);
      throw new Error('The consumer was closed while repositioning.');
    }
    this.bind(entry, next);
    await closeQuietly(old);
  }
}

async function closeQuietly(stream: SessionStream): Promise<void> {
  try {
    await Promise.resolve(stream.close());
  } catch {
    /* best effort — the replacement is already live */
  }
}
