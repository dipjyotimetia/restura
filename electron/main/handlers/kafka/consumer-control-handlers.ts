import type * as KafkaLib from '@platformatic/kafka';
import { ipcMain } from 'electron';
import type { ZodSchema } from 'zod';
import { IPC } from '../../../shared/channels';
import { type KeyedRateLimiter, rateLimited } from '../../ipc/ipc-rate-limiter';
import { errorMessage } from '../../ipc/ipc-utils';
import {
  createValidatedEventHandler,
  KafkaConsumerControlSchema,
  KafkaPartitionControlSchema,
  type KafkaSeekConsumerConfig,
  KafkaSeekConsumerSchema,
} from '../../ipc/ipc-validators';
import {
  assignedKeys,
  type ConsumerSessionEntry,
  type KafkaConsumerSession,
} from './consumer-session';
import type { OrderedDelivery, QueuedRecord } from './ordered-delivery';
import { MAX_PAUSED_PARTITIONS, partitionKey } from './partition-pause';

/** The slice of a live Kafka connection the consumer controls need. */
export interface KafkaConsumerControlEntry extends ConsumerSessionEntry {
  connectionId: string;
  /** Browse mode's ordered emit queue (no session, so no partition controls). */
  browse?: Pick<OrderedDelivery<QueuedRecord>, 'flow'>;
}

interface ConsumerControlDependencies<E extends KafkaConsumerControlEntry> {
  getEntry: (connectionId: string, ownerId: number) => E | undefined;
  getKafka: () => typeof KafkaLib;
  /** Shared Kafka limiter; applied to the partition pause/resume and seek channels. */
  rateLimiter: KeyedRateLimiter;
  /** Publish a `kafka:consumer-status:<id>` lifecycle event to the owning renderer. */
  emitStatus: (entry: E, payload: Record<string, unknown>) => void;
}

type Failure = { success: false; error: string };
const NO_CONSUMER: Failure = { success: false, error: 'No consumer is active.' };

/**
 * Live-consumer controls: whole-stream pause/resume (#938) plus per-partition
 * pause/resume and seek by offset or timestamp (#942). Every handler runs
 * through the Zod-validated wrapper; the partition and seek channels are also
 * rate-limited per renderer.
 */
export function registerKafkaConsumerControlHandlers<E extends KafkaConsumerControlEntry>(
  deps: ConsumerControlDependencies<E>
): void {
  const handle = <TInput, TOutput>(
    channel: string,
    schema: ZodSchema<TInput>,
    handler: (input: TInput, event: Electron.IpcMainInvokeEvent) => Promise<TOutput>
  ): void => {
    ipcMain.handle(
      channel,
      rateLimited(deps.rateLimiter, createValidatedEventHandler(channel, schema, handler))
    );
  };
  const live = (connectionId: string, ownerId: number) => {
    const entry = deps.getEntry(connectionId, ownerId);
    const session = entry?.session;
    return entry && session && entry.stream ? { entry, session } : undefined;
  };

  // Whole-stream pause/resume flips only the *user* reason: the stream stays
  // paused while backpressure still holds it (see consumer-flow.ts).
  const setUserPaused = (channel: string, paused: boolean): void => {
    ipcMain.handle(
      channel,
      createValidatedEventHandler(channel, KafkaConsumerControlSchema, async (cfg, event) => {
        const entry = deps.getEntry(cfg.connectionId, event.sender.id);
        // Browse mode has no session but shares the same flow control.
        const flow = entry?.session?.flow ?? (entry?.stream ? entry.browse?.flow : undefined);
        if (!entry || !flow) return NO_CONSUMER;
        flow.setUserPaused(paused);
        deps.emitStatus(entry, { state: paused ? 'paused' : 'resumed' });
        return { success: true };
      })
    );
  };
  setUserPaused(IPC.kafka.pauseConsumer, true);
  setUserPaused(IPC.kafka.resumeConsumer, false);

  handle(IPC.kafka.pausePartitions, KafkaPartitionControlSchema, async (cfg, event) => {
    const target = live(cfg.connectionId, event.sender.id);
    if (!target) return NO_CONSUMER;
    const { entry, session } = target;
    const invalid = checkPartitions(entry, session, cfg.partitions);
    if (invalid) return invalid;
    for (const p of cfg.partitions) {
      if (!session.partitions.pause(p.topic, p.partition)) {
        return {
          success: false,
          error: `At most ${MAX_PAUSED_PARTITIONS} partitions can be paused at once.`,
          pausedPartitions: session.partitions.list(),
        };
      }
    }
    return { success: true, pausedPartitions: session.partitions.list() };
  });

  handle(IPC.kafka.resumePartitions, KafkaPartitionControlSchema, async (cfg, event) => {
    const target = live(cfg.connectionId, event.sender.id);
    if (!target) return NO_CONSUMER;
    const { entry, session } = target;
    const requested = cfg.partitions.filter((p) =>
      session.partitions.isPaused(p.topic, p.partition)
    );
    if (requested.length === 0)
      return { success: true, pausedPartitions: session.partitions.list() };
    return session.runExclusive(async () => {
      const restore: Array<[string, number, bigint | undefined]> = [];
      // Runs after the drain: partitions that withheld records rewind to the first one.
      const plan = () => {
        const rewinds = new Map<string, bigint>();
        for (const { topic, partition } of requested) {
          if (!session.partitions.isPaused(topic, partition)) continue;
          const rewindTo = session.partitions.resume(topic, partition);
          restore.push([topic, partition, rewindTo]);
          if (rewindTo !== undefined) rewinds.set(partitionKey(topic, partition), rewindTo);
        }
        return rewinds;
      };
      try {
        await session.reposition(entry, plan);
      } catch (err) {
        // Keep the partitions paused with their rewind points, so a retry still rewinds.
        for (const [topic, partition, rewindTo] of restore) {
          session.partitions.pause(topic, partition);
          if (rewindTo !== undefined) session.partitions.setRewindPoint(topic, partition, rewindTo);
        }
        return { success: false, error: errorMessage(err) };
      }
      return { success: true, pausedPartitions: session.partitions.list() };
    });
  });

  handle(IPC.kafka.seekConsumer, KafkaSeekConsumerSchema, async (cfg, event) => {
    const target = live(cfg.connectionId, event.sender.id);
    if (!target) return NO_CONSUMER;
    const { entry, session } = target;
    const invalid = checkPartitions(entry, session, [cfg]);
    if (invalid) return invalid;
    return session.runExclusive(async () => {
      try {
        const consumer = entry.consumer;
        if (!consumer) return NO_CONSUMER;
        const offset = await resolveSeekOffset(consumer, cfg, deps.getKafka());
        if (session.partitions.isPaused(cfg.topic, cfg.partition)) {
          // A paused partition just moves its resume point; it lands there on resume.
          session.partitions.setRewindPoint(cfg.topic, cfg.partition, offset);
        } else {
          const key = partitionKey(cfg.topic, cfg.partition);
          await session.reposition(entry, () => new Map([[key, offset]]));
        }
        return { success: true, offset: offset.toString() };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    });
  });
}

/** Partitions must belong to the subscription *and* be assigned to this group member. */
function checkPartitions(
  entry: ConsumerSessionEntry,
  session: KafkaConsumerSession,
  partitions: ReadonlyArray<{ topic: string; partition: number }>
): Failure | undefined {
  const assigned = entry.consumer ? assignedKeys(entry.consumer) : undefined;
  for (const { topic, partition } of partitions) {
    if (!session.topics.includes(topic)) {
      return { success: false, error: `Topic "${topic}" is not part of this subscription.` };
    }
    if (!assigned?.has(partitionKey(topic, partition))) {
      return {
        success: false,
        error: `Partition ${partition} of "${topic}" is not assigned to this consumer.`,
      };
    }
  }
  return undefined;
}

/**
 * Resolve a seek target to a concrete offset inside the partition's current
 * [log-start, log-end] range. Out-of-range offsets are clamped (rather than
 * left to the stream's out-of-range fallback); a timestamp with no record at
 * or after it lands at the log end, like a tail.
 */
async function resolveSeekOffset(
  consumer: NonNullable<ConsumerSessionEntry['consumer']>,
  cfg: KafkaSeekConsumerConfig,
  kafka: typeof KafkaLib
): Promise<bigint> {
  const scope = { topics: [cfg.topic], partitions: { [cfg.topic]: [cfg.partition] } };
  const watermark = async (timestamp: bigint): Promise<bigint> => {
    const offsets = await consumer.listOffsets({ ...scope, timestamp });
    const offset = offsets.get(cfg.topic)?.[cfg.partition];
    if (typeof offset !== 'bigint' || offset < 0n) {
      throw new Error(`Partition ${cfg.partition} of "${cfg.topic}" was not found.`);
    }
    return offset;
  };
  const [earliest, latest] = await Promise.all([
    watermark(kafka.ListOffsetTimestamps.EARLIEST),
    watermark(kafka.ListOffsetTimestamps.LATEST),
  ]);
  let wanted: bigint;
  if (cfg.target.kind === 'offset') {
    wanted = BigInt(cfg.target.offset);
  } else {
    const byTime = await consumer.listOffsetsWithTimestamps({
      ...scope,
      timestamp: BigInt(cfg.target.timestamp),
    });
    const found = byTime.get(cfg.topic)?.get(cfg.partition)?.offset;
    wanted = typeof found === 'bigint' && found >= 0n ? found : latest;
  }
  if (wanted < earliest) return earliest;
  if (wanted > latest) return latest;
  return wanted;
}
