import type * as KafkaLib from '@platformatic/kafka';
import type { KafkaOffsetResetRow, KafkaOffsetResetSkip } from '../../../types/api/protocols';
import type {
  KafkaDeleteGroupOffsetsConfig,
  KafkaResetGroupOffsetsConfig,
} from '../../ipc/ipc-validators';

/**
 * Consumer-group offset reset / delete planning (issue #934), kept out of
 * admin-handlers.ts so the IPC registration stays thin and this logic is unit
 * testable against a fake Admin.
 *
 * Semantics (mirrors `kafka-consumer-groups.sh --reset-offsets` where sensible):
 * - Scope: a single `topic` covers every partition of that topic (metadata);
 *   `allTopics` covers every topic/partition the group has a committed offset for.
 * - `timestamp`: ListOffsets with the epoch-ms timestamp → the earliest offset whose
 *   record timestamp is >= it. When the broker reports -1 (no such record) the
 *   partition falls back to the latest offset (note `timestamp-fallback-latest`).
 * - `shift`: committed offset ± N, clamped to [earliest, latest]. Partitions with
 *   no committed offset are skipped and reported (we never invent a base) — they
 *   keep following the consumer's auto.offset.reset policy.
 * - Apply and delete require an inactive group (no members, not rebalancing).
 *   The broker enforces this too; the pre-check gives a clear error. `dryRun`
 *   only reads, so it skips the membership check.
 */

export type OffsetAdmin = Pick<
  KafkaLib.Admin,
  | 'describeGroups'
  | 'listConsumerGroupOffsets'
  | 'listOffsets'
  | 'metadata'
  | 'alterConsumerGroupOffsets'
  | 'deleteConsumerGroupOffsets'
>;

export interface OffsetTimestamps {
  EARLIEST: bigint;
  LATEST: bigint;
}

export type OffsetResetRow = KafkaOffsetResetRow;
export type OffsetResetSkip = KafkaOffsetResetSkip;
export type OffsetResetNote = NonNullable<OffsetResetRow['note']>;

export interface OffsetResetResult {
  offsets: OffsetResetRow[];
  skipped: OffsetResetSkip[];
  dryRun: boolean;
}

type Scope = Map<string, number[]>;
type Committed = Map<string, Map<number, bigint>>;

// Normalised (upper-case, no separators) states in which a group still has
// live/joining members and therefore may not have its offsets rewritten.
const ACTIVE_STATES = new Set([
  'STABLE',
  'PREPARINGREBALANCE',
  'COMPLETINGREBALANCE',
  'ASSIGNING',
  'RECONCILING',
]);

export async function assertGroupInactive(
  admin: OffsetAdmin,
  groupId: string,
  action: string
): Promise<void> {
  const group = (await admin.describeGroups({ groups: [groupId] })).get(groupId);
  if (!group) return;
  const state = String(group.state);
  const members = group.members?.size ?? 0;
  if (members > 0 || ACTIVE_STATES.has(state.toUpperCase().replace(/[_\s]/g, ''))) {
    throw new Error(
      `Cannot ${action} consumer group "${groupId}": it has ${members} active member(s) ` +
        `(state ${state}). Stop all consumers in the group first.`
    );
  }
}

export function clampShift(
  committed: bigint,
  shift: bigint,
  earliest: bigint,
  latest: bigint
): { offset: bigint; note?: OffsetResetNote } {
  const target = committed + shift;
  if (target < earliest) return { offset: earliest, note: 'clamped-earliest' };
  if (target > latest) return { offset: latest, note: 'clamped-latest' };
  return { offset: target };
}

async function readCommitted(admin: OffsetAdmin, groupId: string): Promise<Committed> {
  const groups = await admin.listConsumerGroupOffsets({ groups: [{ groupId }] });
  const committed: Committed = new Map();
  for (const topic of groups.find((group) => group.groupId === groupId)?.topics ?? []) {
    for (const partition of topic.partitions) {
      if (partition.committedOffset < 0n) continue;
      let byPartition = committed.get(topic.name);
      if (!byPartition) {
        byPartition = new Map();
        committed.set(topic.name, byPartition);
      }
      byPartition.set(partition.partitionIndex, partition.committedOffset);
    }
  }
  return committed;
}

/** Every committed topic/partition, topics and partitions sorted. */
function committedScope(committed: Committed): Scope {
  return new Map(
    Array.from(committed.keys())
      .sort()
      .map((topic) => [topic, Array.from(committed.get(topic)!.keys()).sort((a, b) => a - b)])
  );
}

async function topicPartitions(admin: OffsetAdmin, topic: string): Promise<number[]> {
  const metadata = await admin.metadata({
    topics: [topic],
    autocreateTopics: false,
    forceUpdate: true,
  });
  const count = metadata.topics.get(topic)?.partitionsCount ?? 0;
  if (count === 0) throw new Error(`Topic "${topic}" has no partitions or does not exist.`);
  return Array.from({ length: count }, (_, index) => index);
}

async function listAt(
  admin: OffsetAdmin,
  scope: Scope,
  timestamp: bigint
): Promise<Map<string, bigint>> {
  const listed = await admin.listOffsets({
    topics: Array.from(scope, ([name, partitions]) => ({
      name,
      partitions: partitions.map((partitionIndex) => ({ partitionIndex, timestamp })),
    })),
  });
  const offsets = new Map<string, bigint>();
  for (const topic of listed) {
    for (const partition of topic.partitions) {
      offsets.set(`${topic.name}/${partition.partitionIndex}`, partition.offset);
    }
  }
  return offsets;
}

const noCommits = (groupId: string, topic?: string): Error =>
  new Error(
    `Consumer group "${groupId}" has no committed offsets${topic ? ` for topic "${topic}"` : ''}.`
  );

export async function planOffsetReset(
  admin: OffsetAdmin,
  timestamps: OffsetTimestamps,
  cfg: KafkaResetGroupOffsetsConfig
): Promise<Omit<OffsetResetResult, 'dryRun'>> {
  const committed = await readCommitted(admin, cfg.groupId);
  const previousOf = (topic: string, partition: number): string | null =>
    committed.get(topic)?.get(partition)?.toString() ?? null;

  if (cfg.to === 'specific') {
    const topic = cfg.topic!;
    return {
      offsets: (cfg.partitions ?? []).map(({ partition, offset }) => ({
        topic,
        partition,
        previous: previousOf(topic, partition),
        offset,
      })),
      skipped: [],
    };
  }

  let scope: Scope;
  if (cfg.allTopics) {
    scope = committedScope(committed);
    if (scope.size === 0) throw noCommits(cfg.groupId);
  } else {
    scope = new Map([[cfg.topic!, await topicPartitions(admin, cfg.topic!)]]);
  }

  const skipped: OffsetResetSkip[] = [];
  if (cfg.to === 'shift') {
    // Only partitions with a committed offset can be shifted.
    for (const [topic, partitions] of scope) {
      const kept = partitions.filter((partition) => {
        const has = committed.get(topic)?.has(partition) ?? false;
        if (!has) skipped.push({ topic, partition, reason: 'no-committed-offset' });
        return has;
      });
      if (kept.length > 0) scope.set(topic, kept);
      else scope.delete(topic);
    }
    if (scope.size === 0) throw noCommits(cfg.groupId, cfg.topic);
  }

  const needsLatest = cfg.to !== 'earliest';
  const needsEarliest = cfg.to === 'earliest' || cfg.to === 'shift';
  const [earliest, latest, atTimestamp] = await Promise.all([
    needsEarliest ? listAt(admin, scope, timestamps.EARLIEST) : undefined,
    needsLatest ? listAt(admin, scope, timestamps.LATEST) : undefined,
    cfg.to === 'timestamp' ? listAt(admin, scope, BigInt(cfg.timestamp!)) : undefined,
  ]);

  const offsets: OffsetResetRow[] = [];
  for (const [topic, partitions] of scope) {
    for (const partition of partitions) {
      const key = `${topic}/${partition}`;
      const previous = previousOf(topic, partition);
      let target: { offset: bigint; note?: OffsetResetNote };
      if (cfg.to === 'earliest') {
        target = { offset: earliest!.get(key) ?? 0n };
      } else if (cfg.to === 'latest') {
        target = { offset: latest!.get(key) ?? 0n };
      } else if (cfg.to === 'timestamp') {
        const found = atTimestamp!.get(key) ?? -1n;
        target =
          found >= 0n
            ? { offset: found }
            : { offset: latest!.get(key) ?? 0n, note: 'timestamp-fallback-latest' };
      } else {
        target = clampShift(
          committed.get(topic)!.get(partition)!,
          BigInt(cfg.shift!),
          earliest!.get(key) ?? 0n,
          latest!.get(key) ?? 0n
        );
      }
      offsets.push({
        topic,
        partition,
        previous,
        offset: target.offset.toString(),
        ...(target.note ? { note: target.note } : {}),
      });
    }
  }
  return { offsets, skipped };
}

export async function resetGroupOffsets(
  admin: OffsetAdmin,
  timestamps: OffsetTimestamps,
  cfg: KafkaResetGroupOffsetsConfig
): Promise<OffsetResetResult> {
  const dryRun = cfg.dryRun === true;
  if (!dryRun) await assertGroupInactive(admin, cfg.groupId, 'reset offsets for');
  const plan = await planOffsetReset(admin, timestamps, cfg);
  if (!dryRun) {
    const byTopic = new Map<string, { partition: number; offset: bigint }[]>();
    for (const row of plan.offsets) {
      const list = byTopic.get(row.topic) ?? [];
      list.push({ partition: row.partition, offset: BigInt(row.offset) });
      byTopic.set(row.topic, list);
    }
    await admin.alterConsumerGroupOffsets({
      groupId: cfg.groupId,
      topics: Array.from(byTopic, ([name, partitionOffsets]) => ({ name, partitionOffsets })),
    });
  }
  return { ...plan, dryRun };
}

export async function deleteGroupOffsets(
  admin: OffsetAdmin,
  cfg: KafkaDeleteGroupOffsetsConfig
): Promise<{ deleted: { topic: string; partitions: number[] }[] }> {
  await assertGroupInactive(admin, cfg.groupId, 'delete offsets for');
  const scope = committedScope(await readCommitted(admin, cfg.groupId));
  let topics: { name: string; partitionIndexes: number[] }[];
  if (cfg.allTopics) {
    topics = Array.from(scope, ([name, partitionIndexes]) => ({ name, partitionIndexes }));
  } else {
    const partitionIndexes = cfg.partitions ?? scope.get(cfg.topic!) ?? [];
    topics = partitionIndexes.length > 0 ? [{ name: cfg.topic!, partitionIndexes }] : [];
  }
  if (topics.length === 0) throw noCommits(cfg.groupId, cfg.topic);
  const deleted = await admin.deleteConsumerGroupOffsets({ groupId: cfg.groupId, topics });
  return {
    deleted: deleted.map((topic) => ({ topic: topic.name, partitions: topic.partitionIndexes })),
  };
}
