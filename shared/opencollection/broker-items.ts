import { v4 as uuid } from 'uuid';
import type {
  BrokerPresetTls,
  KafkaPresetConnection,
  KafkaPresetConsumeMode,
  KafkaPresetPayloadMode,
  KafkaRequest,
  MqttPresetPublish,
  MqttPresetQoS,
  MqttRequest,
} from '../types';
import { kvFromInternal, kvToInternal } from './key-value';

/**
 * OpenCollection mapping for Kafka / MQTT connection presets (#984).
 *
 * OpenCollection has no broker item type and the vendored JSON schema closes
 * items with `additionalProperties: false`, so presets ride in root
 * `extensions['x-restura-kafka']` / `['x-restura-mqtt']` lists — exactly like
 * SSE / MCP (`x-restura-sse` / `x-restura-mcp`), including the `folderPath`
 * placement (#866). Entry shape:
 *
 *   - info: { type: kafka, name, description? }
 *     folderPath: [Folder, Sub]        # stamped by from-internal
 *     kafka: { connection, produce, consume }
 *
 * The internal preset types carry no secrets (see shared/types/broker.ts), so
 * these mappers cannot emit one. Import is lenient: missing or malformed
 * fields fall back to the defaults a fresh Kafka/MQTT tab would use, and
 * unknown keys are ignored (never copied into the typed preset).
 */

export const KAFKA_EXTENSION_KEY = 'x-restura-kafka';
export const MQTT_EXTENSION_KEY = 'x-restura-mqtt';

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : fallback;
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const oneOf = <T>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const stringRecord = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Obj).filter(
    (e): e is [string, string] => typeof e[1] === 'string'
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/** `T` with every key optional and `undefined` removed (sound under exactOptionalPropertyTypes). */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Copy only the defined keys of `src` — keeps exported YAML free of `undefined`s. */
function defined<T extends Obj>(src: T): Defined<T> {
  return Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined)) as Defined<T>;
}

function info(type: 'kafka' | 'mqtt', name: string, description: string | undefined): Obj {
  return defined({ type, name, description });
}

function tlsFromInternal(t: BrokerPresetTls | undefined): Obj | undefined {
  if (!t) return undefined;
  return defined({
    caPath: t.caPath,
    certPath: t.certPath,
    keyPath: t.keyPath,
    rejectUnauthorized: t.rejectUnauthorized,
  });
}

function tlsToInternal(v: unknown): BrokerPresetTls | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = obj(v);
  return defined({
    caPath: optStr(t.caPath),
    certPath: optStr(t.certPath),
    keyPath: optStr(t.keyPath),
    rejectUnauthorized:
      typeof t.rejectUnauthorized === 'boolean' ? t.rejectUnauthorized : undefined,
  }) as BrokerPresetTls;
}

const SECURITY = ['PLAINTEXT', 'SASL_PLAINTEXT', 'SASL_SSL', 'SSL'] as const;
const MECHANISMS = ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512', 'OAUTHBEARER'] as const;
const COMPRESSION = ['none', 'gzip', 'snappy', 'lz4', 'zstd'] as const;
const PAYLOAD_MODES: readonly KafkaPresetPayloadMode[] = ['utf8', 'base64', 'json'];
const CONSUME_MODES: readonly KafkaPresetConsumeMode[] = [
  'committed',
  'latest',
  'earliest',
  'manual',
  'timestamp',
];
const QOS: readonly MqttPresetQoS[] = [0, 1, 2];

// ---------------------------------------------------------------------------
// Kafka
// ---------------------------------------------------------------------------

export function kafkaToOC(name: string, r: KafkaRequest): unknown {
  const c = r.connection;
  const connection = defined({
    bootstrapBrokers: c.bootstrapBrokers,
    clientId: c.clientId,
    securityProtocol: c.securityProtocol,
    sasl: c.sasl
      ? defined({
          mechanism: c.sasl.mechanism,
          username: c.sasl.username,
          extensions: c.sasl.extensions,
        })
      : undefined,
    tls: tlsFromInternal(c.tls),
    registry: c.registry
      ? defined({
          url: c.registry.url,
          authType: c.registry.authType,
          username: c.registry.username,
        })
      : undefined,
    acks: c.acks,
    compression: c.compression,
    idempotent: c.idempotent,
    transactionalId: c.transactionalId,
  });
  const produce = defined({
    topic: r.produce.topic,
    key: r.produce.key,
    keyEncoding: r.produce.keyEncoding,
    value: r.produce.value,
    valueEncoding: r.produce.valueEncoding,
    headers: r.produce.headers.length > 0 ? r.produce.headers.map(kvFromInternal) : undefined,
    partition: r.produce.partition,
  });
  return {
    info: info('kafka', name, r.description),
    kafka: {
      connection,
      produce,
      consume: { groupId: r.consume.groupId, topics: r.consume.topics, mode: r.consume.mode },
    },
  };
}

export function kafkaEntryToInternal(entry: Obj): KafkaRequest {
  const i = obj(entry.info);
  const k = obj(entry.kafka);
  const c = obj(k.connection);
  const p = obj(k.produce);
  const q = obj(k.consume);
  const connection: KafkaPresetConnection = {
    bootstrapBrokers: strArray(c.bootstrapBrokers),
    clientId: str(c.clientId),
    securityProtocol: oneOf(c.securityProtocol, SECURITY, 'PLAINTEXT'),
    acks: oneOf(c.acks, [0, 1, -1] as const, 1),
    compression: oneOf(c.compression, COMPRESSION, 'none'),
    idempotent: bool(c.idempotent, false),
  };
  if (c.sasl && typeof c.sasl === 'object') {
    const s = obj(c.sasl);
    connection.sasl = {
      mechanism: oneOf(s.mechanism, MECHANISMS, 'PLAIN'),
      ...defined({ username: optStr(s.username), extensions: stringRecord(s.extensions) }),
    };
  }
  const tls = tlsToInternal(c.tls);
  if (tls) connection.tls = tls;
  if (c.registry && typeof c.registry === 'object') {
    const reg = obj(c.registry);
    connection.registry = {
      url: str(reg.url),
      ...defined({
        authType: reg.authType === 'basic' || reg.authType === 'bearer' ? reg.authType : undefined,
        username: optStr(reg.username),
      }),
    };
  }
  if (typeof c.transactionalId === 'string') connection.transactionalId = c.transactionalId;

  const name = str(i.name, 'Kafka');
  const req: KafkaRequest = {
    id: uuid(),
    name,
    type: 'kafka',
    connection,
    produce: {
      topic: str(p.topic),
      key: str(p.key),
      keyEncoding: oneOf(p.keyEncoding, PAYLOAD_MODES, 'utf8'),
      value: str(p.value),
      valueEncoding: oneOf(p.valueEncoding, PAYLOAD_MODES, 'utf8'),
      headers: Array.isArray(p.headers) ? p.headers.map(kvToInternal) : [],
    },
    consume: {
      groupId: str(q.groupId),
      topics: strArray(q.topics),
      mode: oneOf(q.mode, CONSUME_MODES, 'committed'),
    },
  };
  if (typeof p.partition === 'number' && Number.isSafeInteger(p.partition) && p.partition >= 0) {
    req.produce.partition = p.partition;
  }
  if (typeof i.description === 'string') req.description = i.description;
  return req;
}

// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------

function publishToInternal(v: unknown): Omit<MqttPresetPublish, 'name'> {
  const p = obj(v);
  return {
    topic: str(p.topic),
    payload: str(p.payload),
    qos: oneOf(p.qos, QOS, 0),
    retain: bool(p.retain, false),
    ...defined({
      contentType: optStr(p.contentType),
      responseTopic: optStr(p.responseTopic),
      userProperties: stringRecord(p.userProperties),
    }),
  };
}

function publishFromInternal(p: Omit<MqttPresetPublish, 'name'>): Obj {
  return defined({
    topic: p.topic,
    payload: p.payload,
    qos: p.qos,
    retain: p.retain,
    contentType: p.contentType,
    responseTopic: p.responseTopic,
    userProperties: p.userProperties,
  });
}

export function mqttToOC(name: string, r: MqttRequest): unknown {
  const c = r.connection;
  // Explicit field picks (never a spread): only modelled, non-secret fields
  // can reach the export even if a stray property rides along at runtime.
  const connection = defined({
    brokerUrl: c.brokerUrl,
    protocolVersion: c.protocolVersion,
    clientId: c.clientId,
    keepalive: c.keepalive,
    cleanStart: c.cleanStart,
    connectTimeout: c.connectTimeout,
    autoReconnect: c.autoReconnect,
    username: c.username,
    tls: tlsFromInternal(c.tls),
    lwt: c.lwt
      ? { topic: c.lwt.topic, payload: c.lwt.payload, qos: c.lwt.qos, retain: c.lwt.retain }
      : undefined,
    sessionExpiryInterval: c.sessionExpiryInterval,
  });
  const mqtt = defined({
    connection,
    publish: publishFromInternal(r.publish),
    subscribe: { topicFilter: r.subscribe.topicFilter, qos: r.subscribe.qos },
    templates:
      r.templates.length > 0
        ? r.templates.map((t) => ({ name: t.name, ...publishFromInternal(t) }))
        : undefined,
  });
  return { info: info('mqtt', name, r.description), mqtt };
}

export function mqttEntryToInternal(entry: Obj): MqttRequest {
  const i = obj(entry.info);
  const m = obj(entry.mqtt);
  const c = obj(m.connection);
  const s = obj(m.subscribe);
  const connection: MqttRequest['connection'] = {
    brokerUrl: str(c.brokerUrl),
    protocolVersion: oneOf(c.protocolVersion, [4, 5] as const, 5),
    clientId: str(c.clientId),
    keepalive: num(c.keepalive, 60),
    cleanStart: bool(c.cleanStart, true),
    connectTimeout: num(c.connectTimeout, 30_000),
    autoReconnect: bool(c.autoReconnect, true),
  };
  if (typeof c.username === 'string') connection.username = c.username;
  const tls = tlsToInternal(c.tls);
  if (tls) connection.tls = tls;
  if (c.lwt && typeof c.lwt === 'object') {
    const l = obj(c.lwt);
    connection.lwt = {
      topic: str(l.topic),
      payload: str(l.payload),
      qos: oneOf(l.qos, QOS, 0),
      retain: bool(l.retain, false),
    };
  }
  if (typeof c.sessionExpiryInterval === 'number') {
    connection.sessionExpiryInterval = num(c.sessionExpiryInterval, 0);
  }
  const req: MqttRequest = {
    id: uuid(),
    name: str(i.name, 'MQTT'),
    type: 'mqtt',
    connection,
    publish: publishToInternal(m.publish),
    subscribe: { topicFilter: str(s.topicFilter), qos: oneOf(s.qos, QOS, 0) },
    templates: Array.isArray(m.templates)
      ? m.templates.map((t) => ({ name: str(obj(t).name, 'Publish'), ...publishToInternal(t) }))
      : [],
  };
  if (typeof i.description === 'string') req.description = i.description;
  return req;
}
