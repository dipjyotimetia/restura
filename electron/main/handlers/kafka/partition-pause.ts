/**
 * Partition-level pause for one Kafka subscription (#942).
 *
 * @platformatic/kafka (2.14) has no partition-level pause, so it is emulated:
 * records from a paused partition are withheld (never decoded or sent to the
 * renderer) and the first withheld offset is remembered as the rewind point.
 * Resuming the partition repositions this member's stream there (see
 * `consumer-session.ts`), so the withheld records are delivered after the
 * resume. The partition keeps being fetched while paused — the cost of
 * emulation — but its records are discarded before decode, never count against
 * the emit queue, and are never auto-committed (`delivered-offset-committer.ts`).
 * If the partition is revoked by a rebalance while paused, its pause state is
 * dropped and the new owner starts from the group's committed offset.
 *
 * Independent of the whole-stream pause reasons in `consumer-flow.ts`.
 */

/** Upper bound on simultaneously paused partitions per subscription. */
export const MAX_PAUSED_PARTITIONS = 1_000;

export interface TopicPartition {
  topic: string;
  partition: number;
}

/** Same key shape @platformatic/kafka uses for `offsetsToFetch` (`topic:partition`). */
export function partitionKey(topic: string, partition: number): string {
  return `${topic}:${partition}`;
}

/** Inverse of `partitionKey`. Kafka topic names cannot contain `:`. */
export function parsePartitionKey(key: string): TopicPartition | undefined {
  const sep = key.lastIndexOf(':');
  if (sep <= 0) return undefined;
  const partition = Number(key.slice(sep + 1));
  if (!Number.isInteger(partition) || partition < 0) return undefined;
  return { topic: key.slice(0, sep), partition };
}

interface PausedPartition {
  /** Where the partition resumes; undefined until a record is withheld or a seek pins it. */
  rewindTo?: bigint;
  /** Set by a seek: later withheld records must not pull the resume point back. */
  pinned: boolean;
}

export class PartitionPauseSet {
  readonly #paused = new Map<string, PausedPartition>();

  /** Returns false when the set is already at its cap (the partition is not paused). */
  pause(topic: string, partition: number): boolean {
    const key = partitionKey(topic, partition);
    if (this.#paused.has(key)) return true;
    if (this.#paused.size >= MAX_PAUSED_PARTITIONS) return false;
    this.#paused.set(key, { pinned: false });
    return true;
  }

  /** Forget partitions this member no longer owns (after a rebalance). */
  retain(assigned: ReadonlySet<string>): void {
    for (const key of this.#paused.keys()) if (!assigned.has(key)) this.#paused.delete(key);
  }

  isPaused(topic: string, partition: number): boolean {
    return this.#paused.has(partitionKey(topic, partition));
  }

  /**
   * Unmark a paused partition. Returns the offset to rewind to when records
   * were withheld (or a seek landed) while it was paused, `undefined` otherwise.
   */
  resume(topic: string, partition: number): bigint | undefined {
    const key = partitionKey(topic, partition);
    const state = this.#paused.get(key);
    this.#paused.delete(key);
    return state?.rewindTo;
  }

  /** Pin a paused partition's resume position (seek while paused). */
  setRewindPoint(topic: string, partition: number, offset: bigint): void {
    const state = this.#paused.get(partitionKey(topic, partition));
    if (!state) return;
    state.rewindTo = offset;
    state.pinned = true;
  }

  list(): TopicPartition[] {
    const out: TopicPartition[] = [];
    for (const key of this.#paused.keys()) {
      const parsed = parsePartitionKey(key);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /**
   * Gate for each consumed record: `false` withholds it (paused partition) and
   * records the earliest withheld offset as that partition's rewind point.
   */
  admit(topic: string, partition: number, offset: bigint): boolean {
    const state = this.#paused.get(partitionKey(topic, partition));
    if (!state) return true;
    if (!state.pinned && (state.rewindTo === undefined || offset < state.rewindTo)) {
      state.rewindTo = offset;
    }
    return false;
  }
}
