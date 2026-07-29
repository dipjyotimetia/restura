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

const KafkaSaslSchema = z.discriminatedUnion('mechanism', [
  z.object({
    mechanism: z.literal('PLAIN'),
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(1024),
  }),
  z.object({
    mechanism: z.literal('SCRAM-SHA-256'),
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(1024),
  }),
  z.object({
    mechanism: z.literal('SCRAM-SHA-512'),
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(1024),
  }),
  z.object({
    mechanism: z.literal('OAUTHBEARER'),
    token: z
      .string()
      .min(1)
      .max(16 * 1024),
    extensions: z.record(z.string().min(1).max(256), z.string().max(1024)).optional(),
  }),
]);

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
    })
    .strict()
    .optional(),
});

export const KafkaConnectSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    clientId: z.string().min(1).max(256),
    bootstrapBrokers: z.array(KafkaBrokerSchema).min(1).max(32),
    auth: KafkaAuthSchema,
    // Enable the idempotent producer (exactly-once-per-partition delivery dedup).
    // An idempotent producer REQUIRES acks=all(-1); the produce handler forces
    // that override when this is set, and the UI locks the acks picker to -1.
    idempotent: z.boolean().optional(),
    transactionalId: z.string().min(1).max(256).optional(),
    registry: KafkaRegistrySchema.optional(),
  })
  .refine((cfg) => cfg.transactionalId === undefined || cfg.idempotent === true, {
    message: 'Producer transactions require idempotent mode.',
    path: ['transactionalId'],
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

const strictBase64 = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) =>
        value.length % 4 === 0 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
      'Invalid Base64 payload'
    );

const KafkaDataFieldSchema = (max: number) =>
  z.discriminatedUnion('encoding', [
    z.object({ encoding: z.literal('utf8'), data: z.string().max(max) }).strict(),
    z.object({ encoding: z.literal('base64'), data: strictBase64(max) }).strict(),
  ]);

const KafkaSchemaFieldSchema = (max: number) =>
  z
    .object({
      encoding: z.literal('schema'),
      schemaId: z.number().int().positive(),
      data: z.string().max(max),
    })
    .strict();

export const KafkaRecordFieldSchema = z.discriminatedUnion('encoding', [
  ...KafkaDataFieldSchema(KAFKA_MAX_VALUE_BYTES).options,
  KafkaSchemaFieldSchema(KAFKA_MAX_VALUE_BYTES),
  z.object({ encoding: z.literal('null') }).strict(),
]);

const KafkaKeyFieldSchema = z.discriminatedUnion('encoding', [
  ...KafkaDataFieldSchema(KAFKA_MAX_KEY_BYTES).options,
  KafkaSchemaFieldSchema(KAFKA_MAX_KEY_BYTES),
  z.object({ encoding: z.literal('null') }).strict(),
]);

const KafkaHeaderSchema = z
  .object({
    key: KafkaDataFieldSchema(256),
    value: KafkaDataFieldSchema(64 * 1024),
  })
  .strict();

export const KafkaProduceRecordSchema = z
  .object({
    topic: KafkaTopicSchema,
    key: KafkaKeyFieldSchema.optional(),
    value: KafkaRecordFieldSchema,
    headers: z.array(KafkaHeaderSchema).max(100).optional(),
    partition: z.number().int().nonnegative().max(2_147_483_647).optional(),
    timestamp: z
      .string()
      .min(1)
      .max(20)
      .regex(/^\d+$/, 'Timestamp must be a non-negative integer string')
      .optional(),
  })
  .strict();

const KafkaSendOptionsSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  acks: KafkaAcksSchema,
  compression: KafkaCompressionSchema.optional(),
});

export const KafkaProduceSchema = KafkaSendOptionsSchema.extend({
  record: KafkaProduceRecordSchema,
});

export const KafkaProduceBatchSchema = KafkaSendOptionsSchema.extend({
  records: z.array(KafkaProduceRecordSchema).min(1).max(1000),
});

export const KafkaProducerStreamOpenSchema = KafkaSendOptionsSchema.extend({
  highWaterMark: z.number().int().positive().max(100_000).optional(),
  batchSize: z.number().int().positive().max(10_000).optional(),
  batchTime: z.number().int().nonnegative().max(60_000).optional(),
});

export const KafkaProducerStreamWriteSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  record: KafkaProduceRecordSchema,
});

export const KafkaProducerStreamCloseSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

export const KafkaTransactionBeginSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

export const KafkaTransactionEndSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  action: z.enum(['commit', 'abort']),
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

export const KafkaSubscribeSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    groupId: KafkaGroupIdSchema,
    topics: z.array(KafkaTopicSchema).min(1).max(50),
    mode: z.enum(['committed', 'latest', 'earliest', 'manual', 'timestamp']).default('committed'),
    /** Accepted during the v1->v2 renderer migration; ignored by the main process. */
    fromBeginning: z.boolean().optional(),
    fallbackMode: z.enum(['latest', 'earliest', 'fail']).optional(),
    offsets: z.array(KafkaPartitionOffsetSchema).min(1).max(200).optional(),
    timestamp: z
      .string()
      .min(1)
      .max(20)
      .regex(/^\d+$/, 'Timestamp must be a non-negative integer string (epoch ms)')
      .optional(),
    commitPolicy: z.enum(['auto', 'manual']).optional(),
    autoCommitIntervalMs: z.number().int().positive().max(3_600_000).optional(),
    isolation: z.enum(['read-uncommitted', 'read-committed']).optional(),
    groupProtocol: z.enum(['classic', 'consumer']).optional(),
    groupInstanceId: z.string().min(1).max(249).optional(),
    groupRemoteAssignor: z.string().min(1).max(249).optional(),
    sessionTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    rebalanceTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    heartbeatIntervalMs: z.number().int().positive().max(3_600_000).optional(),
    minBytes: z
      .number()
      .int()
      .nonnegative()
      .max(100 * 1024 * 1024)
      .optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024)
      .optional(),
    maxBytesPerPartition: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024)
      .optional(),
    maxWaitTimeMs: z.number().int().nonnegative().max(300_000).optional(),
    highWaterMark: z.number().int().positive().max(100_000).optional(),
    lagIntervalMs: z.number().int().min(250).max(3_600_000).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mode === 'manual' && !cfg.offsets?.length) {
      ctx.addIssue({ code: 'custom', path: ['offsets'], message: 'Manual mode requires offsets.' });
    }
    if (cfg.mode === 'timestamp' && !cfg.timestamp) {
      ctx.addIssue({
        code: 'custom',
        path: ['timestamp'],
        message: 'Timestamp mode requires a timestamp.',
      });
    }
    if (cfg.groupProtocol === 'consumer' && cfg.heartbeatIntervalMs !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['heartbeatIntervalMs'],
        message: 'The consumer group protocol manages heartbeat timing broker-side.',
      });
    }
  });

export const KafkaConsumerControlSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

export const KafkaCommitMessageSchema = KafkaConsumerControlSchema.extend({
  commitToken: z.string().min(1).max(128),
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

const KafkaConfirmationSchema = z.string().min(1).max(512);

export const KafkaCreatePartitionsSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    topic: KafkaTopicSchema,
    count: z.number().int().positive().max(10_000),
    validateOnly: z.boolean().default(true),
    confirmation: KafkaConfirmationSchema.optional(),
  })
  .refine((cfg) => cfg.validateOnly || cfg.confirmation === `ALTER ${cfg.topic}`, {
    message: 'Type ALTER followed by the topic name to apply this change.',
    path: ['confirmation'],
  });

const KafkaConfigMutationSchema = z.discriminatedUnion('operation', [
  z.object({
    name: z.string().min(1).max(256),
    operation: z.enum(['set', 'append', 'subtract']),
    value: z.string().max(64 * 1024),
  }),
  z.object({
    name: z.string().min(1).max(256),
    operation: z.literal('delete'),
  }),
]);

export const KafkaAlterTopicConfigsSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    topic: KafkaTopicSchema,
    configs: z.array(KafkaConfigMutationSchema).min(1).max(100),
    validateOnly: z.boolean().default(true),
    confirmation: KafkaConfirmationSchema.optional(),
  })
  .refine((cfg) => cfg.validateOnly || cfg.confirmation === `ALTER ${cfg.topic}`, {
    message: 'Type ALTER followed by the topic name to apply this change.',
    path: ['confirmation'],
  });

export const KafkaDeleteRecordsSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    topic: KafkaTopicSchema,
    partitions: z
      .array(
        z.object({
          partition: z.number().int().nonnegative().max(2_147_483_647),
          offset: z.string().regex(/^\d+$/).max(20),
        })
      )
      .min(1)
      .max(1000),
    confirmation: KafkaConfirmationSchema,
  })
  .refine((cfg) => cfg.confirmation === `DELETE RECORDS ${cfg.topic}`, {
    message: 'Type DELETE RECORDS followed by the topic name.',
    path: ['confirmation'],
  });

export const KafkaDescribeClusterSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

const KafkaAclSchema = z.object({
  resourceType: z.number().int().min(0).max(7),
  resourceName: z.string().min(1).max(249),
  resourcePatternType: z.number().int().min(0).max(4),
  principal: z.string().min(1).max(512),
  host: z.string().min(1).max(253),
  operation: z.number().int().min(0).max(15),
  permissionType: z.number().int().min(0).max(3),
});

export const KafkaDescribeAclsSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  filter: KafkaAclSchema.extend({
    resourceName: z.string().max(249).nullable().optional(),
    principal: z.string().max(512).nullable().optional(),
    host: z.string().max(253).nullable().optional(),
  }),
});

export const KafkaCreateAclSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    acl: KafkaAclSchema,
    confirmation: KafkaConfirmationSchema,
  })
  .refine((cfg) => cfg.confirmation === 'CREATE ACL', {
    message: 'Type CREATE ACL to apply this access-control change.',
    path: ['confirmation'],
  });

export const KafkaDeleteAclsSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    filter: KafkaDescribeAclsSchema.shape.filter,
    confirmation: KafkaConfirmationSchema,
  })
  .refine((cfg) => cfg.confirmation === 'DELETE ACLS', {
    message: 'Type DELETE ACLS to apply this access-control change.',
    path: ['confirmation'],
  });

const KafkaQuotaEntitySchema = z.object({
  entityType: z.enum(['user', 'client-id']),
  entityName: z.string().max(256).nullable().optional(),
});

export const KafkaDescribeQuotasSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  entities: z.array(KafkaQuotaEntitySchema).min(1).max(10),
});

export const KafkaAlterQuotasSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    entities: z.array(KafkaQuotaEntitySchema).min(1).max(10),
    operations: z
      .array(
        z.object({
          key: z.enum(['producer_byte_rate', 'consumer_byte_rate', 'request_percentage']),
          value: z.number().nonnegative().optional(),
          remove: z.boolean().default(false),
        })
      )
      .min(1)
      .max(20),
    validateOnly: z.boolean().default(true),
    confirmation: KafkaConfirmationSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.validateOnly && cfg.confirmation !== 'ALTER QUOTAS') {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmation'],
        message: 'Type ALTER QUOTAS to apply this quota change.',
      });
    }
    for (const [index, operation] of cfg.operations.entries()) {
      if (!operation.remove && operation.value === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'value'],
          message: 'A quota value is required unless remove is selected.',
        });
      }
    }
  });

export type KafkaConnectConfig = z.infer<typeof KafkaConnectSchema>;
export type KafkaProduceConfig = z.infer<typeof KafkaProduceSchema>;
export type KafkaProduceBatchConfig = z.infer<typeof KafkaProduceBatchSchema>;
export type KafkaProducerStreamOpenConfig = z.infer<typeof KafkaProducerStreamOpenSchema>;
export type KafkaProducerStreamWriteConfig = z.infer<typeof KafkaProducerStreamWriteSchema>;
export type KafkaProducerStreamCloseConfig = z.infer<typeof KafkaProducerStreamCloseSchema>;
export type KafkaTransactionBeginConfig = z.infer<typeof KafkaTransactionBeginSchema>;
export type KafkaTransactionEndConfig = z.infer<typeof KafkaTransactionEndSchema>;
export type KafkaSubscribeConfig = z.infer<typeof KafkaSubscribeSchema>;
export type KafkaConsumerControlConfig = z.infer<typeof KafkaConsumerControlSchema>;
export type KafkaCommitMessageConfig = z.infer<typeof KafkaCommitMessageSchema>;
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
export type KafkaCreatePartitionsConfig = z.infer<typeof KafkaCreatePartitionsSchema>;
export type KafkaAlterTopicConfigsConfig = z.infer<typeof KafkaAlterTopicConfigsSchema>;
export type KafkaDeleteRecordsConfig = z.infer<typeof KafkaDeleteRecordsSchema>;
export type KafkaDescribeAclsConfig = z.infer<typeof KafkaDescribeAclsSchema>;
export type KafkaCreateAclConfig = z.infer<typeof KafkaCreateAclSchema>;
export type KafkaDeleteAclsConfig = z.infer<typeof KafkaDeleteAclsSchema>;
export type KafkaDescribeQuotasConfig = z.infer<typeof KafkaDescribeQuotasSchema>;
export type KafkaAlterQuotasConfig = z.infer<typeof KafkaAlterQuotasSchema>;
