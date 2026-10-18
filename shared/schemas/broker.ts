import { z } from 'zod';
import { keyValueSchema } from './key-value';

/**
 * Zod schemas for the Kafka / MQTT collection presets (#984) — see
 * `shared/types/broker.ts`. Objects use Zod's default key stripping, so a
 * secret smuggled onto a preset (e.g. `sasl.password`) is dropped on
 * validation rather than persisted: presets never carry credentials.
 */

const tlsSchema = z.object({
  caPath: z.string().optional(),
  certPath: z.string().optional(),
  keyPath: z.string().optional(),
  rejectUnauthorized: z.boolean().optional(),
});

const payloadModeSchema = z.enum(['utf8', 'base64', 'json']);
const qosSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const kafkaRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('kafka'),
  description: z.string().optional(),
  connection: z.object({
    bootstrapBrokers: z.array(z.string()),
    clientId: z.string(),
    securityProtocol: z.enum(['PLAINTEXT', 'SASL_PLAINTEXT', 'SASL_SSL', 'SSL']),
    sasl: z
      .object({
        mechanism: z.enum(['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512', 'OAUTHBEARER']),
        username: z.string().optional(),
        extensions: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    tls: tlsSchema.optional(),
    registry: z.object({ url: z.string(), username: z.string().optional() }).optional(),
    acks: z.union([z.literal(0), z.literal(1), z.literal(-1)]),
    compression: z.enum(['none', 'gzip', 'snappy', 'lz4', 'zstd']),
    idempotent: z.boolean(),
    transactionalId: z.string().optional(),
  }),
  produce: z.object({
    topic: z.string(),
    key: z.string(),
    keyEncoding: payloadModeSchema,
    value: z.string(),
    valueEncoding: payloadModeSchema,
    headers: z.array(keyValueSchema),
    partition: z.number().int().nonnegative().optional(),
  }),
  consume: z.object({
    groupId: z.string(),
    topics: z.array(z.string()),
    mode: z.enum(['committed', 'latest', 'earliest', 'manual', 'timestamp']),
  }),
});

const mqttPublishSchema = z.object({
  topic: z.string(),
  payload: z.string(),
  qos: qosSchema,
  retain: z.boolean(),
  contentType: z.string().optional(),
  responseTopic: z.string().optional(),
  userProperties: z.record(z.string(), z.string()).optional(),
});

export const mqttRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('mqtt'),
  description: z.string().optional(),
  connection: z.object({
    brokerUrl: z.string(),
    protocolVersion: z.union([z.literal(4), z.literal(5)]),
    clientId: z.string(),
    keepalive: z.number().int().nonnegative(),
    cleanStart: z.boolean(),
    connectTimeout: z.number().int().nonnegative(),
    autoReconnect: z.boolean(),
    username: z.string().optional(),
    tls: tlsSchema.optional(),
    lwt: z
      .object({ topic: z.string(), payload: z.string(), qos: qosSchema, retain: z.boolean() })
      .optional(),
    sessionExpiryInterval: z.number().int().nonnegative().optional(),
  }),
  publish: mqttPublishSchema,
  subscribe: z.object({ topicFilter: z.string(), qos: qosSchema }),
  templates: z.array(mqttPublishSchema.extend({ name: z.string() })),
});
