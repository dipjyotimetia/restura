import { z } from 'zod';
import { ConnectionIdSchema } from './core';

// ===========================
// Kafka Schemas
// ===========================

export const KafkaConnectionIdSchema = ConnectionIdSchema;

// host:port — loose syntactic check; real reachability is enforced by the
// Kafka client when it dials the broker. We cap length and forbid junk so the
// schema rejects obviously bad input early.
const KafkaBrokerSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+:\d{1,5}$/, 'Broker must be host:port (alphanumeric host, numeric port)')
  .refine((broker) => {
    const port = Number(broker.slice(broker.lastIndexOf(':') + 1));
    return Number.isInteger(port) && port >= 1 && port <= 65_535;
  }, 'Broker port must be between 1 and 65535');

const KafkaSaslMechanismSchema = z.enum(['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512']);

const KafkaSaslSchema = z.object({
  mechanism: KafkaSaslMechanismSchema,
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

const KafkaTlsSchema = z.object({
  ca: z
    .string()
    .max(64 * 1024)
    .optional(),
  cert: z
    .string()
    .max(64 * 1024)
    .optional(),
  key: z
    .string()
    .max(64 * 1024)
    .optional(),
  passphrase: z.string().max(1024).optional(),
  rejectUnauthorized: z.boolean().optional(),
});

const KafkaAuthSchema = z.discriminatedUnion('securityProtocol', [
  z.object({ securityProtocol: z.literal('PLAINTEXT') }),
  z.object({
    securityProtocol: z.literal('SASL_PLAINTEXT'),
    sasl: KafkaSaslSchema,
  }),
  z.object({
    securityProtocol: z.literal('SASL_SSL'),
    sasl: KafkaSaslSchema,
    tls: KafkaTlsSchema.optional(),
  }),
  z.object({
    securityProtocol: z.literal('SSL'),
    tls: KafkaTlsSchema,
  }),
]);

export const KafkaCompressionSchema = z.enum(['none', 'gzip', 'snappy', 'lz4', 'zstd']);
export const KafkaAcksSchema = z.union([z.literal(0), z.literal(1), z.literal(-1)]);

// Confluent Schema Registry. `url` is SSRF-guarded at connect; auth holds the
// already-resolved plaintext (kafkaManager resolves secret sentinels first).
const KafkaRegistrySchema = z.object({
  url: z.url('Invalid Schema Registry URL').max(2048),
  auth: z
    .object({
      username: z.string().max(256).optional(),
      password: z.string().max(1024).optional(),
      token: z.string().max(4096).optional(),
    })
    .optional(),
});

export const KafkaConnectSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  clientId: z.string().min(1).max(256),
  bootstrapBrokers: z.array(KafkaBrokerSchema).min(1).max(32),
  auth: KafkaAuthSchema,
  // Enable the idempotent producer (exactly-once-per-partition delivery dedup).
  // An idempotent producer REQUIRES acks=all(-1); the produce handler forces
  // that override when this is set, and the UI locks the acks picker to -1.
  idempotent: z.boolean().optional(),
  registry: KafkaRegistrySchema.optional(),
});

// Topic naming rules per Kafka: max 249 chars, [a-zA-Z0-9._-]; we also forbid
// leading dot/dash for sanity.
const KafkaTopicSchema = z
  .string()
  .min(1)
  .max(249)
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/,
    'Topic must start with [a-zA-Z0-9_] and contain only [a-zA-Z0-9._-]'
  );

// 10MB per-message ceiling — well above the typical Kafka 1MB default, but
// callers can lower it via broker config. Stops a malformed renderer from
// queueing a 1GB string over IPC.
const KAFKA_MAX_VALUE_BYTES = 10 * 1024 * 1024;
const KAFKA_MAX_KEY_BYTES = 1 * 1024 * 1024;

export const KafkaProduceSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  topic: KafkaTopicSchema,
  key: z.string().max(KAFKA_MAX_KEY_BYTES).optional(),
  value: z.string().max(KAFKA_MAX_VALUE_BYTES),
  headers: z.record(z.string().min(1).max(256), z.string().max(64 * 1024)).optional(),
  partition: z.number().int().nonnegative().max(2_147_483_647).optional(),
  acks: KafkaAcksSchema,
  compression: KafkaCompressionSchema.optional(),
  // Confluent Schema Registry schema ids. When set (registry connections only),
  // that field is parsed as JSON and encoded with the given schema. Key and value
  // are independent.
  valueSchemaId: z.number().int().positive().optional(),
  keySchemaId: z.number().int().positive().optional(),
});

// Per-partition starting offset for MANUAL consume mode. `offset` is a numeric
// string because the underlying lib uses bigint offsets (TopicWithPartitionAndOffset)
// — a string avoids JS Number precision loss past 2^53 and bigint/IPC friction.
const KafkaPartitionOffsetSchema = z.object({
  topic: KafkaTopicSchema,
  partition: z.number().int().nonnegative().max(2_147_483_647),
  offset: z.string().min(1).max(20).regex(/^\d+$/, 'Offset must be a non-negative integer string'),
});

// Consumer-group id — reused by subscribe and the group admin ops.
const KafkaGroupIdSchema = z.string().min(1).max(256);

export const KafkaSubscribeSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  groupId: KafkaGroupIdSchema,
  topics: z.array(KafkaTopicSchema).min(1).max(50),
  // Start position. 'latest'/'earliest' map to the lib's stream modes;
  // 'manual' seeks to the explicit per-partition `offsets` below; 'timestamp'
  // resolves each partition's first offset at/after `timestamp` (epoch ms) and
  // then seeks there via the MANUAL path. `fromBeginning` is kept for back-compat
  // and used only when `mode` is omitted.
  fromBeginning: z.boolean(),
  mode: z.enum(['latest', 'earliest', 'manual', 'timestamp']).optional(),
  offsets: z.array(KafkaPartitionOffsetSchema).min(1).max(200).optional(),
  // Epoch-millis as a numeric string (bigint at the wire). Required when
  // mode === 'timestamp'; ignored otherwise.
  timestamp: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d+$/, 'Timestamp must be a non-negative integer string (epoch ms)')
    .optional(),
});

export const KafkaUnsubscribeSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

export const KafkaDisconnectSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

// ---------------------------------------------------------------------------
// Kafka Admin (topic + consumer-group management). Each op constructs a
// short-lived Admin client from the connection's already-validated clientOptions
// (auth/TLS reused) and closes it in a finally.
// ---------------------------------------------------------------------------

export const KafkaListTopicsSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

export const KafkaCreateTopicSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  topic: KafkaTopicSchema,
  // Broker is the real authority on limits; these caps just reject obviously
  // bad input early.
  partitions: z.number().int().positive().max(10_000),
  replicationFactor: z.number().int().positive().max(16),
});

export const KafkaDeleteTopicSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  topic: KafkaTopicSchema,
});

export const KafkaListGroupsSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

// Topic inspector: partition watermarks (earliest/latest) + topic config.
export const KafkaInspectTopicSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  topic: KafkaTopicSchema,
});

// Consumer-group inspector: members/state + committed offsets + computed lag.
export const KafkaInspectGroupSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  groupId: KafkaGroupIdSchema,
});

// Reset a consumer group's committed offsets for one topic. 'earliest'/'latest'
// resolve the target offsets broker-side; 'specific' takes explicit per-partition
// offsets (required in that case). Kafka rejects this unless the group is inactive.
export const KafkaResetGroupOffsetsSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    groupId: KafkaGroupIdSchema,
    topic: KafkaTopicSchema,
    to: z.enum(['earliest', 'latest', 'specific']),
    // Same per-partition offset shape as the MANUAL-seek spec, minus the topic
    // (the topic is a top-level field here).
    partitions: z
      .array(KafkaPartitionOffsetSchema.omit({ topic: true }))
      .min(1)
      .max(1000)
      .optional(),
  })
  .refine((v) => v.to !== 'specific' || (v.partitions?.length ?? 0) > 0, {
    message: "partitions (with offsets) are required when to === 'specific'",
    path: ['partitions'],
  });

export const KafkaDeleteGroupSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  groupId: KafkaGroupIdSchema,
});

export type KafkaConnectConfig = z.infer<typeof KafkaConnectSchema>;
export type KafkaProduceConfig = z.infer<typeof KafkaProduceSchema>;
export type KafkaSubscribeConfig = z.infer<typeof KafkaSubscribeSchema>;
export type KafkaUnsubscribeConfig = z.infer<typeof KafkaUnsubscribeSchema>;
export type KafkaDisconnectConfig = z.infer<typeof KafkaDisconnectSchema>;
export type KafkaListTopicsConfig = z.infer<typeof KafkaListTopicsSchema>;
export type KafkaCreateTopicConfig = z.infer<typeof KafkaCreateTopicSchema>;
export type KafkaDeleteTopicConfig = z.infer<typeof KafkaDeleteTopicSchema>;
export type KafkaListGroupsConfig = z.infer<typeof KafkaListGroupsSchema>;
export type KafkaInspectTopicConfig = z.infer<typeof KafkaInspectTopicSchema>;
export type KafkaInspectGroupConfig = z.infer<typeof KafkaInspectGroupSchema>;
export type KafkaResetGroupOffsetsConfig = z.infer<typeof KafkaResetGroupOffsetsSchema>;
export type KafkaDeleteGroupConfig = z.infer<typeof KafkaDeleteGroupSchema>;
