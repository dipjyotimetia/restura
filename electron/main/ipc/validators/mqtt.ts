import { protocolSecretValueSchema } from '@shared/protocol/secret-value-schema';
import { z } from 'zod';
import { ConnectionIdSchema } from './core';

// ===========================
// MQTT Schemas
// ===========================

export const MqttConnectionIdSchema = ConnectionIdSchema;

// mqtt:// (TCP), mqtts:// (TLS) and MQTT over WebSocket — ws:// / wss:// with
// an optional path such as `/mqtt` (MQTT 5.0 §6). Every transport passes the
// same broker SSRF guard, DNS check and execution policy in the handler.
export const MQTT_BROKER_SCHEMES = ['mqtt:', 'mqtts:', 'ws:', 'wss:'] as const;

const MqttBrokerUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (u) => {
      try {
        return (MQTT_BROKER_SCHEMES as readonly string[]).includes(new URL(u).protocol);
      } catch {
        return false;
      }
    },
    { message: 'Broker URL must be a valid mqtt://, mqtts://, ws:// or wss:// URL' }
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

/**
 * How a binary field crosses IPC: `utf8` text or `base64` for arbitrary bytes
 * (MQTT payloads and correlation data are Binary Data — MQTT 5.0 §1.5.6).
 */
const MqttBinaryEncodingSchema = z.enum(['utf8', 'base64']);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Reject a `base64` field whose text is not canonical Base64. */
function base64Ok(value: string | undefined, encoding: 'utf8' | 'base64' | undefined): boolean {
  return (
    value === undefined ||
    encoding !== 'base64' ||
    (value.length % 4 === 0 && BASE64_RE.test(value))
  );
}

// SecretValue per ADR-0007 — the renderer sends `{ kind: 'handle', id }` and
// main resolves it at wire time. External secret-manager refs are refused.
const MqttSecretValueSchema = protocolSecretValueSchema.refine(
  (value) => typeof value === 'string' || value.kind !== 'external',
  'External secret references are not supported for MQTT credentials'
);

const MqttUserPropertiesSchema = z
  .record(
    z.string().max(256),
    z.union([z.string().max(4096), z.array(z.string().max(4096)).max(64)])
  )
  .refine((r) => Object.keys(r).length <= 64, 'At most 64 user properties');

// Four-byte integers (MQTT 5.0 §1.5.3) and Variable Byte Integer ceiling (§1.5.5).
const UINT32 = 4_294_967_295;
const VBI_MAX = 268_435_455;

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
  // TLS files are read in main (SEC-K3) — the renderer sends paths only.
  caPath: z.string().min(1).max(4096).optional(),
  certPath: z.string().min(1).max(4096).optional(),
  keyPath: z.string().min(1).max(4096).optional(),
  passphrase: MqttSecretValueSchema.optional(),
  rejectUnauthorized: z.boolean().optional(),
});

// MQTT 5.0 §3.1.3.2 Will Properties — sent only on a v5 connection.
const MqttWillPropertiesSchema = z
  .object({
    willDelayInterval: z.number().int().nonnegative().max(UINT32).optional(),
    payloadFormatIndicator: z.boolean().optional(),
    messageExpiryInterval: z.number().int().nonnegative().max(UINT32).optional(),
    contentType: z.string().max(256).optional(),
    responseTopic: MqttPublishTopicSchema.optional(),
    correlationData: z.string().max(8192).optional(),
    correlationDataEncoding: MqttBinaryEncodingSchema.optional(),
    userProperties: MqttUserPropertiesSchema.optional(),
  })
  .refine((p) => base64Ok(p.correlationData, p.correlationDataEncoding), {
    message: 'Will correlation data is not valid base64',
  });

const MqttLwtSchema = z
  .object({
    topic: MqttPublishTopicSchema,
    payload: z.string().max(512 * 1024),
    payloadEncoding: MqttBinaryEncodingSchema.optional(),
    qos: MqttQoSSchema,
    retain: z.boolean(),
    properties: MqttWillPropertiesSchema.optional(),
  })
  .refine((l) => base64Ok(l.payload, l.payloadEncoding), {
    message: 'Will payload is not valid base64',
  });

// MQTT 5.0 §3.1.2.11 CONNECT Properties (Session Expiry stays top-level for
// compatibility with saved connections).
const MqttConnectPropertiesSchema = z
  .object({
    receiveMaximum: z.number().int().min(1).max(65535).optional(),
    maximumPacketSize: z.number().int().min(1).max(VBI_MAX).optional(),
    topicAliasMaximum: z.number().int().min(0).max(65535).optional(),
    requestResponseInformation: z.boolean().optional(),
    requestProblemInformation: z.boolean().optional(),
    userProperties: MqttUserPropertiesSchema.optional(),
    // Enhanced authentication (§4.12) — initial AUTH method/data only; a
    // multi-step challenge from the broker is reported as an error.
    authenticationMethod: z.string().min(1).max(256).optional(),
    // Often a credential (token) — the renderer sends a SecretRef handle.
    authenticationData: z.union([z.string().max(8192), MqttSecretValueSchema]).optional(),
    authenticationDataEncoding: MqttBinaryEncodingSchema.optional(),
  })
  .refine(
    (p) =>
      typeof p.authenticationData !== 'string' ||
      base64Ok(p.authenticationData, p.authenticationDataEncoding),
    { message: 'Authentication data is not valid base64' }
  )
  .refine((p) => p.authenticationData === undefined || p.authenticationMethod !== undefined, {
    message: 'Authentication data requires an authentication method',
  });

// 10MB per-message ceiling, matching Kafka's. Stops a malformed renderer from
// queueing a giant string over IPC. Base64 text is 4/3 of the bytes it carries.
const MQTT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MQTT_MAX_PAYLOAD_TEXT = Math.ceil((MQTT_MAX_PAYLOAD_BYTES * 4) / 3) + 4;

export const MqttConnectSchema = z
  .object({
    connectionId: MqttConnectionIdSchema,
    brokerUrl: MqttBrokerUrlSchema,
    // 4 = MQTT 3.1.1, 5 = MQTT 5.0.
    protocolVersion: z.union([z.literal(4), z.literal(5)]),
    // Empty is allowed on v5 with Clean Start — the broker assigns one (§3.1.3.1).
    clientId: z.string().max(256),
    keepalive: z.number().int().min(0).max(65535),
    cleanStart: z.boolean(),
    connectTimeout: z.number().int().positive().max(300_000).optional(),
    autoReconnect: z.boolean(),
    username: z.string().max(256).optional(),
    password: MqttSecretValueSchema.optional(),
    tls: MqttTlsSchema.optional(),
    lwt: MqttLwtSchema.optional(),
    sessionExpiryInterval: z.number().int().nonnegative().max(UINT32).optional(),
    properties: MqttConnectPropertiesSchema.optional(),
  })
  .refine((c) => c.clientId.length > 0 || (c.protocolVersion === 5 && c.cleanStart), {
    message: 'Client ID is required (an empty ID is only allowed on MQTT 5 with Clean Start)',
    path: ['clientId'],
  });

const MqttPublishFields = {
  connectionId: MqttConnectionIdSchema,
  topic: MqttPublishTopicSchema,
  payload: z.string().max(MQTT_MAX_PAYLOAD_TEXT),
  payloadEncoding: MqttBinaryEncodingSchema.optional(),
  qos: MqttQoSSchema,
  retain: z.boolean(),
  // MQTT 5.0 extras — rejected by the handler on a v3.1.1 connection.
  userProperties: MqttUserPropertiesSchema.optional(),
  messageExpiryInterval: z.number().int().nonnegative().max(UINT32).optional(),
  contentType: z.string().max(256).optional(),
  // §3.3.2.3.2 — true = payload is UTF-8 character data.
  payloadFormatIndicator: z.boolean().optional(),
};

export const MqttPublishSchema = z
  .object({
    ...MqttPublishFields,
    // §3.3.2.3.4 — bounded by the broker's Topic Alias Maximum (checked in main).
    topicAlias: z.number().int().min(1).max(65535).optional(),
    responseTopic: MqttPublishTopicSchema.optional(),
    // MQTT 5 request/response correlation token, echoed back on the response topic.
    correlationData: z.string().max(8192).optional(),
    correlationDataEncoding: MqttBinaryEncodingSchema.optional(),
  })
  .refine((p) => base64Ok(p.payload, p.payloadEncoding), {
    message: 'Payload is not valid base64',
  })
  .refine((p) => base64Ok(p.correlationData, p.correlationDataEncoding), {
    message: 'Correlation data is not valid base64',
  });

/**
 * MQTT 5 request/response (§4.10): publish with a Response Topic + Correlation
 * Data, wait for the first reply on that topic whose correlation bytes match.
 * Omitted response topic / correlation data are generated in main.
 */
export const MqttRequestSchema = z
  .object({
    ...MqttPublishFields,
    requestId: z.uuid(),
    responseTopic: MqttPublishTopicSchema.optional(),
    correlationData: z.string().min(1).max(8192).optional(),
    correlationDataEncoding: MqttBinaryEncodingSchema.optional(),
    timeoutMs: z.number().int().min(100).max(300_000),
  })
  .refine((p) => base64Ok(p.payload, p.payloadEncoding), {
    message: 'Payload is not valid base64',
  })
  .refine((p) => base64Ok(p.correlationData, p.correlationDataEncoding), {
    message: 'Correlation data is not valid base64',
  });

export const MqttRequestCancelSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  requestId: z.uuid(),
});

export const MqttSubscribeSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  topicFilter: MqttSubscribeFilterSchema,
  qos: MqttQoSSchema,
  // MQTT 5.0 §3.8.3.1 Subscription Options — rejected on v3.1.1 connections.
  options: z
    .object({
      noLocal: z.boolean().optional(),
      retainAsPublished: z.boolean().optional(),
      retainHandling: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    })
    .optional(),
  // §3.8.2.1.2 Subscription Identifier (Variable Byte Integer, 0 is a protocol error).
  subscriptionIdentifier: z.number().int().min(1).max(VBI_MAX).optional(),
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
export type MqttRequestConfig = z.infer<typeof MqttRequestSchema>;
export type MqttSubscribeConfig = z.infer<typeof MqttSubscribeSchema>;
export type MqttUnsubscribeConfig = z.infer<typeof MqttUnsubscribeSchema>;
export type MqttDisconnectConfig = z.infer<typeof MqttDisconnectSchema>;
