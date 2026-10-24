import type * as KafkaLib from '@platformatic/kafka';
import { partitionKey } from './partition-pause';

type CommitPartition = KafkaLib.CommitOptionsPartition;

/** Default flush interval when the subscription asks for automatic commits without one. */
export const DEFAULT_AUTO_COMMIT_INTERVAL_MS = 1_000;

/**
 * Automatic commits of *delivered* positions (#938/#942 review, M1).
 *
 * The library's own autocommit queues `lastOffset + 1` for every fetched
 * batch at fetch time and flushes it on close — so records withheld from a
 * paused partition (or still queued for decode) would be committed without ever
 * reaching the renderer. Subscriptions therefore run the library with
 * `autocommit: false` and this committer records `offset + 1` only after a
 * record was actually sent to the renderer, flushing on an interval and on
 * close/unsubscribe/stream swap. A withheld partition never advances.
 *
 * Positions are last-write-wins per partition: after a backward seek the next
 * flush commits the lower offset (Kafka accepts it).
 */
export class DeliveredOffsetCommitter {
  readonly #pending = new Map<string, CommitPartition>();
  readonly #timer: ReturnType<typeof setInterval>;
  #chain: Promise<void> = Promise.resolve();
  #failing = false;

  constructor(
    private readonly commit: (offsets: CommitPartition[]) => Promise<void>,
    intervalMs: number,
    private readonly onError: (err: Error) => void,
    /** Partitions this member currently owns; others are dropped at flush, never retried. */
    private readonly owned?: () => ReadonlySet<string> | undefined
  ) {
    this.#timer = setInterval(() => void this.flush(), intervalMs);
    this.#timer.unref?.();
  }

  /** A record was delivered to the renderer: its partition may commit past it. */
  delivered(topic: string, partition: number, offset: bigint, leaderEpoch: number): void {
    this.#pending.set(partitionKey(topic, partition), {
      topic,
      partition,
      offset: offset + 1n,
      leaderEpoch,
    });
  }

  /** Drop queued positions for partitions this member no longer owns. */
  retain(assigned: ReadonlySet<string>): void {
    for (const key of this.#pending.keys()) if (!assigned.has(key)) this.#pending.delete(key);
  }

  /** Commit everything delivered so far. Serialized; never rejects. */
  flush(): Promise<void> {
    this.#chain = this.#chain.then(async () => {
      if (this.#pending.size === 0) return;
      const owned = this.owned?.();
      const offsets = [...this.#pending.entries()]
        .filter(([key]) => !owned || owned.has(key))
        .map(([, offset]) => offset);
      this.#pending.clear();
      if (offsets.length === 0) return;
      try {
        await this.commit(offsets);
        this.#failing = false;
      } catch (err) {
        // Re-queue unless a newer position was delivered meanwhile.
        for (const o of offsets) {
          const key = partitionKey(o.topic, o.partition);
          if (!this.#pending.has(key)) this.#pending.set(key, o);
        }
        // Report the first failure of a streak, not every interval tick.
        if (!this.#failing) {
          this.#failing = true;
          this.onError(new Error(`Offset commit failed: ${(err as Error).message ?? err}`));
        }
      }
    });
    return this.#chain;
  }

  /** Stop the interval and make a final flush. */
  close(): Promise<void> {
    clearInterval(this.#timer);
    return this.flush();
  }
}
