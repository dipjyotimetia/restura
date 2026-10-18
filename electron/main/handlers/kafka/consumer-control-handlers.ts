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
import type { ConsumerSessionEntry } from './consumer-session';
import { partitionKey } from './partition-pause';

/** The slice of a live Kafka connection the consumer controls need. */
export interface KafkaConsumerControlEntry extends ConsumerSessionEntry {
  connectionId: string;
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
        if (!entry?.session) return NO_CONSUMER;
        entry.session.flow.setUserPaused(paused);
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
    const { session } = target;
    const unknown = cfg.partitions.find((p) => !session.topics.includes(p.topic));
    if (unknown) return notSubscribed(unknown.topic);
    for (const p of cfg.partitions) session.partitions.pause(p.topic, p.partition);
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
        await session.reposition(entry, plan, manualMode(deps));
      } catch (err) {
        // Keep the partitions paused (with their rewind points) so nothing is skipped.
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
    if (!session.topics.includes(cfg.topic)) return notSubscribed(cfg.topic);
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
          await session.reposition(entry, () => new Map([[key, offset]]), manualMode(deps));
        }
        return { success: true, offset: offset.toString() };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    });
  });
}

function notSubscribed(topic: string): Failure {
  return { success: false, error: `Topic "${topic}" is not part of this subscription.` };
}

function manualMode(deps: { getKafka: () => typeof KafkaLib }): KafkaLib.MessagesStreamModeValue {
  return deps.getKafka().MessagesStreamModes.MANUAL;
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
