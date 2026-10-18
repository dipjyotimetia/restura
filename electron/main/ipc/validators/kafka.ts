import { isIPv6 } from 'node:net';
import {
  findNonMskBrokers,
  isPlaintextTokenEndpointAllowed,
  isValidOAuthExtensionKey,
  isValidOAuthExtensionValue,
  MAX_OAUTH_EXTENSIONS,
} from '@shared/protocol/kafka-sasl-policy';
import { protocolSecretValueSchema } from '@shared/protocol/secret-value-schema';
import { z } from 'zod';
import { ConnectionIdSchema } from './core';

// ===========================
// Kafka Schemas
// ===========================

export const KafkaConnectionIdSchema = ConnectionIdSchema;

// host:port or [ipv6]:port (RFC 3986 IP-literal) — loose syntactic check; real
// reachability is enforced by the Kafka client when it dials the broker and the
// SSRF policy by assertKafkaBrokersSafe. We cap length and forbid junk so the
// schema rejects obviously bad input early. `@platformatic/kafka` strips the
// brackets itself, so the literal is passed through unchanged.
const KAFKA_HOST_PORT_RE = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\]):(\d{1,5})$/;

const KafkaBrokerSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(
    KAFKA_HOST_PORT_RE,
    'Broker must be host:port or [ipv6]:port (alphanumeric host, numeric port)'
  )
  .refine((broker) => {
    // Bracketed hosts must hold a syntactically valid IPv6 address.
    if (broker.startsWith('[')) return isIPv6(broker.slice(1, broker.indexOf(']')));
    return true;
  }, 'Broker IPv6 literal is not a valid address')
  .refine((broker) => {
    const port = Number(KAFKA_HOST_PORT_RE.exec(broker)?.[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65_535;
  }, 'Broker port must be between 1 and 65535');

const KafkaOAuthExtensionsSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(256)
      .refine(
        isValidOAuthExtensionKey,
        'Extension keys must contain only letters (RFC 7628) and must not be "auth"'
      ),
    z
      .string()
      .min(1)
      .max(1024)
      .refine(
        isValidOAuthExtensionValue,
        'Extension values must be printable ASCII (spaces, tabs and line breaks allowed)'
      )
  )
  .refine(
    (extensions) => Object.keys(extensions).length <= MAX_OAUTH_EXTENSIONS,
    `At most ${MAX_OAUTH_EXTENSIONS} OAuth extensions are allowed`
  )
  .optional();

// Secret-bearing fields added for #918 accept plain string | inline | handle.
// The renderer sends `kafka`-scoped handles, so plaintext is resolved in main
// only (ADR-0007).
// External secret-manager references are refused for Kafka (no opt-in path).
const KafkaSecretValueSchema = protocolSecretValueSchema
  .refine(
    (value) =>
      typeof value === 'string'
        ? value.length > 0
        : value.kind !== 'inline' || value.value.length > 0,
    'Secret is required'
  )
  .refine(
    (value) => typeof value === 'string' || value.kind !== 'external',
    'External secret references are not supported for Kafka SASL credentials'
  );

const KafkaTokenEndpointSchema = z
  .url('Invalid OAuth token endpoint')
  .max(2048)
  .refine(
    isPlaintextTokenEndpointAllowed,
    'OAuth token endpoint must use https (http is allowed only for loopback or private IP hosts)'
  );

// Service and principal names flow into the native GSSAPI library (the service
// becomes the SPN `service@broker-host`) — keep them to the characters Kerberos
// names actually use.
const KafkaKerberosServiceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, 'Invalid Kerberos service name');
const KafkaKerberosPrincipalSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?(?:@[A-Za-z0-9._-]+)?$/,
    'Invalid Kerberos principal'
  );

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
  // Nested on `mode`; `mode` is optional on the static variant so pre-#918
  // configs keep parsing.
  z.discriminatedUnion('mode', [
    // Static bearer token. `mode` is optional so pre-#918 configs keep parsing.
    z.object({
      mechanism: z.literal('OAUTHBEARER'),
      mode: z.literal('static').optional(),
      token: z
        .string()
        .min(1)
        .max(16 * 1024),
      extensions: KafkaOAuthExtensionsSchema,
    }),
    // OAuth 2.0 client-credentials: main fetches + refreshes the token.
    z.object({
      mechanism: z.literal('OAUTHBEARER'),
      mode: z.literal('client-credentials'),
      tokenEndpoint: KafkaTokenEndpointSchema,
      clientId: z.string().min(1).max(512),
      clientSecret: KafkaSecretValueSchema,
      scope: z.string().max(1024).optional(),
      extensions: KafkaOAuthExtensionsSchema,
    }),
  ]),
  z.object({
    mechanism: z.literal('GSSAPI'),
    serviceName: KafkaKerberosServiceSchema.optional(),
    principal: KafkaKerberosPrincipalSchema.optional(),
  }),
  // AWS MSK IAM — signed as a SigV4 presigned token over SASL/OAUTHBEARER.
  z.object({
    mechanism: z.literal('AWS_MSK_IAM'),
    region: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'Invalid AWS region'),
    // MSK IAM tokens are not bound to a cluster: by default every bootstrap
    // broker must be an MSK endpoint in `region`. PrivateLink / custom-DNS
    // setups opt out explicitly (the UI gates this behind a warning).
    allowNonAwsBrokerHosts: z.boolean().optional(),
    credentials: z.discriminatedUnion('source', [
      z.object({
        source: z.literal('static'),
        accessKeyId: z
          .string()
          .min(16)
          .max(128)
          .regex(/^[A-Z0-9]+$/, 'Invalid AWS access key id'),
        secretAccessKey: KafkaSecretValueSchema,
        sessionToken: KafkaSecretValueSchema.optional(),
      }),
      z.object({
        source: z.literal('profile'),
        profile: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._+=,@-]+$/, 'Invalid AWS profile name'),
      }),
    ]),
  }),
]);

export type KafkaSaslConfig = z.infer<typeof KafkaSaslSchema>;

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

// Confluent Schema Registry. `url` is SSRF-guarded (string + DNS) at connect.
// Basic auth holds already-resolved plaintext (kafkaManager resolves secret
// sentinels first); a bearer token is a SecretValue so a keychain handle or
// external reference is resolved only in main (ADR-0007).
const KafkaRegistryBasicFields = {
  username: z.string().max(256).optional(),
  password: z.string().max(1024).optional(),
};
const KafkaRegistryAuthSchema = z.union([
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('basic'), ...KafkaRegistryBasicFields }).strict(),
    z
      .object({ type: z.literal('bearer'), token: protocolSecretValueSchema })
      .strict()
      .refine(
        (auth) =>
          typeof auth.token === 'string'
            ? auth.token.length > 0
            : auth.token.kind !== 'inline' || auth.token.value.length > 0,
        { message: 'A bearer token is required.', path: ['token'] }
      ),
  ]),
  // Untyped legacy shape — HTTP Basic, exactly as before bearer support.
  z
    .object(KafkaRegistryBasicFields)
    .strict()
    .transform((auth) => ({ type: 'basic' as const, ...auth })),
]);

const KafkaRegistrySchema = z.object({
  url: z
    .url('Invalid Schema Registry URL')
    .max(2048)
    // Credentials belong in the auth block; URL userinfo would become implicit Basic auth.
    .refine((url) => {
      if (!URL.canParse(url)) return true; // z.url already reported it
      const parsed = new URL(url);
      return !parsed.username && !parsed.password;
    }, 'Put Schema Registry credentials in the auth settings, not the URL'),
  auth: KafkaRegistryAuthSchema.optional(),
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
  })
  .refine(
    (cfg) =>
      !('sasl' in cfg.auth) ||
      cfg.auth.sasl.mechanism !== 'AWS_MSK_IAM' ||
      cfg.auth.securityProtocol === 'SASL_SSL',
    { message: 'AWS MSK IAM requires SASL_SSL.', path: ['auth', 'securityProtocol'] }
  )
  .superRefine((cfg, ctx) => {
    if (!('sasl' in cfg.auth) || cfg.auth.sasl.mechanism !== 'AWS_MSK_IAM') return;
    if (cfg.auth.sasl.allowNonAwsBrokerHosts === true) return;
    const outside = findNonMskBrokers(cfg.bootstrapBrokers, cfg.auth.sasl.region);
    if (outside.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['bootstrapBrokers'],
        message: `AWS MSK IAM brokers must be MSK endpoints in ${cfg.auth.sasl.region} (*.kafka.${cfg.auth.sasl.region}.amazonaws.com); enable "allow non-AWS broker hosts" for PrivateLink or custom DNS.`,
      });
    }
  });

// Topic naming rules per Kafka: max 249 chars, [a-zA-Z0-9._-]; we also forbid
// leading dot/dash for sanity.
export const KafkaTopicSchema = z
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

// Registry subject names are free-form strings; cap length and forbid control
// characters (they are interpolated into registry REST paths, URL-encoded).
export const KafkaRegistrySubjectSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Subject must not contain control characters')
  // `.` / `..` would be normalised away as dot-segments in the REST path.
  .refine((subject) => subject !== '.' && subject !== '..', 'Subject cannot be "." or ".."');
export const KafkaRegistryVersionSchema = z.union([
  z.number().int().positive().max(2_147_483_647),
  z.literal('latest'),
]);

// A schema-encoded field names its schema either by registry ID or by
// subject + version ('latest' allowed); main resolves the subject to an ID.
const KafkaSchemaFieldSchema = (max: number) =>
  z
    .object({
      encoding: z.literal('schema'),
      schemaId: z.number().int().positive().optional(),
      subject: KafkaRegistrySubjectSchema.optional(),
      version: KafkaRegistryVersionSchema.optional(),
      data: z.string().max(max),
    })
    .strict()
    .superRefine((field, ctx) => {
      const bySubject = field.subject !== undefined || field.version !== undefined;
      if (field.schemaId !== undefined && bySubject) {
        ctx.addIssue({
          code: 'custom',
          path: ['schemaId'],
          message: 'Use either schemaId or subject + version, not both.',
        });
      } else if (field.schemaId === undefined && !bySubject) {
        ctx.addIssue({
          code: 'custom',
          path: ['schemaId'],
          message: 'A schema field requires schemaId or subject + version.',
        });
      } else if (bySubject && (field.subject === undefined || field.version === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: [field.subject === undefined ? 'subject' : 'version'],
          message: 'Subject-based schema fields require both subject and version.',
        });
      }
    });

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
  offset: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d+$/, 'Offset must be a non-negative integer string')
    .refine(
      // Only meaningful once the regex passed (zod v4 runs every check).
      (v) => !/^\d+$/.test(v) || BigInt(v) <= 9_223_372_036_854_775_807n,
      'Offset exceeds the int64 maximum'
    ),
});

// Consumer-group id — reused by subscribe and the group admin ops.
const KafkaGroupIdSchema = z.string().min(1).max(256);

/** Fields that only make sense for a group member; browse mode refuses them. */
const GROUP_ONLY_SUBSCRIBE_FIELDS = [
  'groupId',
  'groupInstanceId',
  'groupRemoteAssignor',
  'fallbackMode',
  'autoCommitIntervalMs',
  'sessionTimeoutMs',
  'rebalanceTimeoutMs',
  'heartbeatIntervalMs',
  'lagIntervalMs',
] as const;

/** Kafka offsets and timestamps are signed 64-bit; browse turns them into BigInts. */
const INT64_MAX = 9_223_372_036_854_775_807n;
const exceedsInt64 = (value: string | undefined): boolean =>
  value !== undefined && /^\d+$/.test(value) && BigInt(value) > INT64_MAX;

function refineSubscribeMembership(
  cfg: {
    membership: 'browse' | 'group';
    mode: string;
    groupId?: string | undefined;
    groupInstanceId?: string | undefined;
    groupRemoteAssignor?: string | undefined;
    fallbackMode?: string | undefined;
    autoCommitIntervalMs?: number | undefined;
    sessionTimeoutMs?: number | undefined;
    rebalanceTimeoutMs?: number | undefined;
    heartbeatIntervalMs?: number | undefined;
    lagIntervalMs?: number | undefined;
    offsets?: Array<{ offset: string }> | undefined;
    timestamp?: string | undefined;
    commitPolicy?: 'auto' | 'manual' | undefined;
    groupProtocol?: 'classic' | 'consumer' | undefined;
    lastN?: number | undefined;
    maxMessages?: number | undefined;
  },
  ctx: z.RefinementCtx
): void {
  const issue = (path: string, message: string): void =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (cfg.mode === 'last-n' && cfg.lastN === undefined) {
    issue('lastN', 'last-n mode requires lastN.');
  }
  if (cfg.membership === 'group') {
    if (!cfg.groupId) issue('groupId', 'Consumer-group mode requires a groupId.');
    if (cfg.mode === 'last-n') issue('mode', 'last-n is only available in browse mode.');
    if (cfg.maxMessages !== undefined) {
      issue('maxMessages', 'A stop-after limit is only available in browse mode.');
    }
    return;
  }
  // Browse: nothing below may reach a group coordinator.
  for (const field of GROUP_ONLY_SUBSCRIBE_FIELDS) {
    if (cfg[field] !== undefined) issue(field, 'Browse mode never uses a consumer group.');
  }
  if (cfg.mode === 'committed') {
    issue('mode', 'Browse mode has no consumer group, so there are no committed offsets.');
  }
  if (cfg.commitPolicy === 'manual') issue('commitPolicy', 'Browse mode never commits offsets.');
  if (cfg.groupProtocol === 'consumer') {
    issue('groupProtocol', 'Browse mode never uses a consumer group.');
  }
  cfg.offsets?.forEach(({ offset }, index) => {
    if (exceedsInt64(offset)) {
      ctx.addIssue({
        code: 'custom',
        path: ['offsets', index, 'offset'],
        message: 'Offset exceeds the Kafka 64-bit maximum.',
      });
    }
  });
  if (exceedsInt64(cfg.timestamp)) issue('timestamp', 'Timestamp exceeds the 64-bit maximum.');
}

export const KafkaSubscribeSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    /** `browse` reads without joining/creating a group or committing (#930). */
    membership: z.enum(['browse', 'group']).default('group'),
    /** Required in group mode; refused in browse mode. */
    groupId: KafkaGroupIdSchema.optional(),
    topics: z.array(KafkaTopicSchema).min(1).max(50),
    mode: z
      .enum(['committed', 'latest', 'earliest', 'manual', 'timestamp', 'last-n'])
      .default('committed'),
    /** Browse `last-n`: start each partition at max(earliest, latest - lastN). */
    lastN: z.number().int().positive().max(1_000_000).optional(),
    /** Browse only: stop after this many records in total. */
    maxMessages: z.number().int().positive().max(1_000_000).optional(),
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
    refineSubscribeMembership(cfg, ctx);
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

// Scope shared by offset reset/delete: exactly one of a single `topic` or
// `allTopics: true` (every topic the group has committed offsets for).
const requireOffsetScope = (
  v: { topic?: string | undefined; allTopics?: boolean | undefined },
  ctx: z.RefinementCtx
): void => {
  if (v.allTopics === true && v.topic !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Use either topic or allTopics, not both',
      path: ['topic'],
    });
  } else if (v.allTopics !== true && v.topic === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'topic is required unless allTopics is true',
      path: ['topic'],
    });
  }
};

// Reset a consumer group's committed offsets (handler: kafka/offset-reset.ts).
// earliest/latest/timestamp resolve broker-side via ListOffsets; shift moves the
// committed offset by ±N, clamped to [earliest, latest]; specific takes explicit
// per-partition offsets. dryRun returns the plan without committing it. The group
// must be inactive — checked before applying and enforced by the broker.
export const KafkaResetGroupOffsetsSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    groupId: KafkaGroupIdSchema,
    topic: KafkaTopicSchema.optional(),
    allTopics: z.boolean().optional(),
    to: z.enum(['earliest', 'latest', 'specific', 'timestamp', 'shift']),
    // Same per-partition offset shape as the MANUAL-seek spec, minus the topic
    // (the topic is a top-level field here).
    partitions: z
      .array(KafkaPartitionOffsetSchema.omit({ topic: true }))
      .min(1)
      .max(1000)
      .optional(),
    // Epoch milliseconds (to === 'timestamp'); capped at the max JS Date.
    timestamp: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
    // Relative move (to === 'shift'); negative rewinds.
    shift: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
    dryRun: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    requireOffsetScope(v, ctx);
    if (v.to === 'specific' && (v.partitions?.length ?? 0) === 0) {
      ctx.addIssue({
        code: 'custom',
        message: "partitions (with offsets) are required when to === 'specific'",
        path: ['partitions'],
      });
    }
    if (v.to === 'specific' && v.allTopics === true) {
      ctx.addIssue({
        code: 'custom',
        message: "allTopics cannot be combined with to === 'specific'",
        path: ['allTopics'],
      });
    }
    if (v.to === 'timestamp' && v.timestamp === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "timestamp is required when to === 'timestamp'",
        path: ['timestamp'],
      });
    }
    if (v.to === 'shift' && v.shift === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "shift is required when to === 'shift'",
        path: ['shift'],
      });
    }
  });

// Delete a group's committed offsets (KIP-496 OffsetDelete). Optional partition
// subset for a single topic; the group must be inactive.
export const KafkaDeleteGroupOffsetsSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    groupId: KafkaGroupIdSchema,
    topic: KafkaTopicSchema.optional(),
    allTopics: z.boolean().optional(),
    partitions: z
      .array(z.number().int().nonnegative().max(2_147_483_647))
      .min(1)
      .max(1000)
      .optional(),
  })
  .superRefine((v, ctx) => {
    requireOffsetScope(v, ctx);
    if (v.allTopics === true && v.partitions !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'partitions can only be used with a single topic',
        path: ['partitions'],
      });
    }
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

// ---------------------------------------------------------------------------
// Schema Registry browsing (subject picker / schema viewer). Read-only; each
// call reuses the live connection's guarded, TLS-policy-aware registry client.
// ---------------------------------------------------------------------------

export const KafkaRegistryListSubjectsSchema = z
  .object({ connectionId: KafkaConnectionIdSchema })
  .strict();

export const KafkaRegistryListVersionsSchema = z
  .object({ connectionId: KafkaConnectionIdSchema, subject: KafkaRegistrySubjectSchema })
  .strict();

export const KafkaRegistryGetSchemaSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    subject: KafkaRegistrySubjectSchema,
    version: KafkaRegistryVersionSchema,
  })
  .strict();

export type KafkaConnectConfig = z.infer<typeof KafkaConnectSchema>;
export type KafkaRegistryConfig = NonNullable<KafkaConnectConfig['registry']>;
export type KafkaRegistryListVersionsConfig = z.infer<typeof KafkaRegistryListVersionsSchema>;
export type KafkaRegistryGetSchemaConfig = z.infer<typeof KafkaRegistryGetSchemaSchema>;
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
export type KafkaDeleteGroupOffsetsConfig = z.infer<typeof KafkaDeleteGroupOffsetsSchema>;
export type KafkaDeleteGroupConfig = z.infer<typeof KafkaDeleteGroupSchema>;
export type KafkaCreatePartitionsConfig = z.infer<typeof KafkaCreatePartitionsSchema>;
export type KafkaAlterTopicConfigsConfig = z.infer<typeof KafkaAlterTopicConfigsSchema>;
export type KafkaDeleteRecordsConfig = z.infer<typeof KafkaDeleteRecordsSchema>;
export type KafkaDescribeAclsConfig = z.infer<typeof KafkaDescribeAclsSchema>;
export type KafkaCreateAclConfig = z.infer<typeof KafkaCreateAclSchema>;
export type KafkaDeleteAclsConfig = z.infer<typeof KafkaDeleteAclsSchema>;
export type KafkaDescribeQuotasConfig = z.infer<typeof KafkaDescribeQuotasSchema>;
export type KafkaAlterQuotasConfig = z.infer<typeof KafkaAlterQuotasSchema>;
