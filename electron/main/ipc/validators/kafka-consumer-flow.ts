import { z } from 'zod';
import { KafkaConnectionIdSchema, KafkaTopicSchema } from './kafka';

// ===========================
// Kafka live-consumer controls (#942): per-partition pause/resume and seek.
// ===========================

const INT64_MAX = 9_223_372_036_854_775_807n;

/** Non-negative int64 carried as a decimal string (offsets and epoch-ms timestamps). */
const KafkaInt64StringSchema = (label: string) =>
  z
    .string()
    .min(1)
    .max(19)
    .regex(/^\d+$/, `${label} must be a non-negative integer string`)
    // Zod still runs refinements after a failed regex; only parse digit strings.
    .refine(
      (value) => !/^\d+$/.test(value) || BigInt(value) <= INT64_MAX,
      `${label} exceeds the int64 range`
    );

const KafkaTopicPartitionSchema = z.object({
  topic: KafkaTopicSchema,
  partition: z.number().int().nonnegative().max(2_147_483_647),
});

export const KafkaPartitionControlSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  partitions: z.array(KafkaTopicPartitionSchema).min(1).max(1000),
});

export const KafkaSeekConsumerSchema = KafkaTopicPartitionSchema.extend({
  connectionId: KafkaConnectionIdSchema,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('offset'), offset: KafkaInt64StringSchema('Offset') }),
    z.object({ kind: z.literal('timestamp'), timestamp: KafkaInt64StringSchema('Timestamp') }),
  ]),
});

export type KafkaPartitionControlConfig = z.infer<typeof KafkaPartitionControlSchema>;
export type KafkaSeekConsumerConfig = z.infer<typeof KafkaSeekConsumerSchema>;
