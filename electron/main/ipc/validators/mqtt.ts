import { z } from 'zod';
import { ConnectionIdSchema } from './core';

// ===========================
// MQTT Schemas
// ===========================

export const MqttConnectionIdSchema = ConnectionIdSchema;

// Only mqtt:// (TCP) and mqtts:// (TLS) — raw-socket transports. ws://wss://
// are deliberately excluded: MQTT-over-WebSocket is not wired (desktop-only,
// raw-socket parity with Kafka).
const MqttBrokerUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (u) => {
      try {
        return ['mqtt:', 'mqtts:'].includes(new URL(u).protocol);
      } catch {
        return false;
      }
    },
    { message: 'Broker URL must be a valid mqtt:// or mqtts:// URL' }
  );

// MQTT topic length ceiling (spec allows up to 65535 UTF-8 bytes).
const MQTT_TOPIC_MAX = 65535;

// PUBLISH topics are concrete — wildcards (`+` / `#`) are illegal in a publish.
const MqttPublishTopicSchema = z
  .string()
  .min(1)
  .max(MQTT_TOPIC_MAX)
  .refine((t) => !t.includes('+') && !t.includes('#'), {
    message: 'Publish topic must not contain wildcards (+ or #)',
  });

// SUBSCRIBE filters allow wildcards: `+` matches exactly one level, `#` matches
// the rest and may appear only as the final level.
const MqttSubscribeFilterSchema = z
  .string()
  .min(1)
  .max(MQTT_TOPIC_MAX)
  .refine(
    (f) => {
      const levels = f.split('/');
      return levels.every((lvl, i) => {
        if (lvl === '#') return i === levels.length - 1;
        if (lvl.includes('#')) return false;
        if (lvl.includes('+') && lvl !== '+') return false;
        return true;
      });
    },
    { message: 'Invalid MQTT topic filter (+ matches one level; # only as the final level)' }
  );

const MqttQoSSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const MqttTlsSchema = z.object({
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

const MqttLwtSchema = z.object({
  topic: MqttPublishTopicSchema,
  payload: z.string().max(256 * 1024),
  qos: MqttQoSSchema,
  retain: z.boolean(),
});

// 10MB per-message ceiling, matching Kafka's. Stops a malformed renderer from
// queueing a giant string over IPC.
const MQTT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

export const MqttConnectSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  brokerUrl: MqttBrokerUrlSchema,
  // 4 = MQTT 3.1.1, 5 = MQTT 5.0.
  protocolVersion: z.union([z.literal(4), z.literal(5)]),
  clientId: z.string().min(1).max(256),
  keepalive: z.number().int().min(0).max(65535),
  cleanStart: z.boolean(),
  connectTimeout: z.number().int().positive().max(300_000),
  autoReconnect: z.boolean(),
  username: z.string().max(256).optional(),
  password: z.string().max(1024).optional(),
  tls: MqttTlsSchema.optional(),
  lwt: MqttLwtSchema.optional(),
  sessionExpiryInterval: z.number().int().nonnegative().max(4_294_967_295).optional(),
});

export const MqttPublishSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  topic: MqttPublishTopicSchema,
  payload: z.string().max(MQTT_MAX_PAYLOAD_BYTES),
  qos: MqttQoSSchema,
  retain: z.boolean(),
  // MQTT 5.0 extras — ignored by the broker on a v3.1.1 connection.
  userProperties: z
    .record(z.string().max(256), z.union([z.string(), z.array(z.string())]))
    .optional(),
  messageExpiryInterval: z.number().int().nonnegative().max(4_294_967_295).optional(),
  contentType: z.string().max(256).optional(),
  responseTopic: MqttPublishTopicSchema.optional(),
  // MQTT 5 request/response correlation token, echoed back on the response topic.
  correlationData: z.string().max(4096).optional(),
});

export const MqttSubscribeSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  topicFilter: MqttSubscribeFilterSchema,
  qos: MqttQoSSchema,
});

export const MqttUnsubscribeSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  topicFilter: MqttSubscribeFilterSchema,
});

export const MqttDisconnectSchema = z.object({
  connectionId: MqttConnectionIdSchema,
});

export type MqttConnectConfig = z.infer<typeof MqttConnectSchema>;
export type MqttPublishConfig = z.infer<typeof MqttPublishSchema>;
export type MqttSubscribeConfig = z.infer<typeof MqttSubscribeSchema>;
export type MqttUnsubscribeConfig = z.infer<typeof MqttUnsubscribeSchema>;
export type MqttDisconnectConfig = z.infer<typeof MqttDisconnectSchema>;
