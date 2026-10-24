import { getElectronAPI } from '@/lib/shared/platform';
import type {
  KafkaPartitionControlResult,
  KafkaSeekTarget,
  KafkaTopicPartition,
} from '../../../../electron/types/electron-api';

export type { KafkaSeekTarget, KafkaTopicPartition };

type PartitionResult = { ok: true; paused: KafkaTopicPartition[] } | { ok: false; error: string };
type SeekResult = { ok: true; offset: string } | { ok: false; error: string };

const UNAVAILABLE = { ok: false as const, error: 'Electron API unavailable.' };

function failure(err: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : fallback };
}

async function partitionCall(
  call: () => Promise<KafkaPartitionControlResult>,
  fallback: string
): Promise<PartitionResult> {
  try {
    const result = await call();
    if (!result.success) return { ok: false, error: result.error ?? fallback };
    return { ok: true, paused: result.pausedPartitions ?? [] };
  } catch (err) {
    // Rate-limit and validation rejections surface as thrown IPC errors.
    return failure(err, fallback);
  }
}

/** Withhold records from these partitions on the live consumer (desktop only). */
export function pauseKafkaPartitions(
  connectionId: string,
  partitions: KafkaTopicPartition[]
): Promise<PartitionResult> {
  const api = getElectronAPI();
  if (!api) return Promise.resolve(UNAVAILABLE);
  return partitionCall(
    () => api.kafka.pausePartitions({ connectionId, partitions }),
    'Pause partition failed'
  );
}

/** Resume paused partitions from the first record withheld while paused. */
export function resumeKafkaPartitions(
  connectionId: string,
  partitions: KafkaTopicPartition[]
): Promise<PartitionResult> {
  const api = getElectronAPI();
  if (!api) return Promise.resolve(UNAVAILABLE);
  return partitionCall(
    () => api.kafka.resumePartitions({ connectionId, partitions }),
    'Resume partition failed'
  );
}

/** Reposition one partition of the live consumer by offset or timestamp. */
export async function seekKafkaPartition(
  connectionId: string,
  partition: KafkaTopicPartition,
  target: KafkaSeekTarget
): Promise<SeekResult> {
  const api = getElectronAPI();
  if (!api) return UNAVAILABLE;
  try {
    const result = await api.kafka.seekConsumer({ connectionId, ...partition, target });
    if (!result.success || result.offset === undefined) {
      return { ok: false, error: result.error ?? 'Seek failed' };
    }
    return { ok: true, offset: result.offset };
  } catch (err) {
    return failure(err, 'Seek failed');
  }
}
