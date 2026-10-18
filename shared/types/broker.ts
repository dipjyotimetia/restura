import type { KeyValue } from './common';

/**
 * Kafka / MQTT connection presets saved as collection items (#984).
 *
 * Both protocols are connection-based and desktop-only: a preset captures the
 * connection (brokers, auth mode, TLS, client id) plus the operation drafts
 * (Kafka produce/consume, MQTT publish/subscribe) so a team can share and
 * git-version them. Opening an item seeds a fresh Kafka/MQTT tab with these
 * values; nothing here is a live connection.
 *
 * SECRETS ARE NOT PART OF THESE SHAPES. SASL passwords / OAuth tokens, TLS key
 * passphrases and Schema Registry passwords live only in the desktop secure
 * store, keyed by the preset's request id (see
 * `src/features/collections/lib/brokerPresetSecrets.ts`). A preset therefore
 * never carries secret material into collection persistence, OpenCollection
 * exports or git-native files — on another machine (or after an import, which
 * mints new ids) the user re-enters the credentials. Every string field may
 * hold `{{var}}` tokens; brokers, topics, keys, payloads and headers are
 * resolved at send time.
 */

export type KafkaPresetSecurityProtocol = 'PLAINTEXT' | 'SASL_PLAINTEXT' | 'SASL_SSL' | 'SSL';
export type KafkaPresetSaslMechanism = 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512' | 'OAUTHBEARER';
export type KafkaPresetCompression = 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
export type KafkaPresetPayloadMode = 'utf8' | 'base64' | 'json';
export type KafkaPresetConsumeMode = 'committed' | 'latest' | 'earliest' | 'manual' | 'timestamp';

/** TLS material is referenced by local file path; the passphrase is never stored here. */
export interface BrokerPresetTls {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  rejectUnauthorized?: boolean;
}

export interface KafkaPresetConnection {
  bootstrapBrokers: string[];
  clientId: string;
  securityProtocol: KafkaPresetSecurityProtocol;
  /** SASL mechanism + username only — the password/token is a local secret. */
  sasl?: {
    mechanism: KafkaPresetSaslMechanism;
    username?: string;
    extensions?: Record<string, string>;
  };
  tls?: BrokerPresetTls;
  /** Schema Registry URL + username only — the password is a local secret. */
  registry?: { url: string; username?: string };
  acks: 0 | 1 | -1;
  compression: KafkaPresetCompression;
  idempotent: boolean;
  transactionalId?: string;
}

export interface KafkaPresetProduce {
  topic: string;
  key: string;
  keyEncoding: KafkaPresetPayloadMode;
  /** Payload template — stored unresolved. */
  value: string;
  valueEncoding: KafkaPresetPayloadMode;
  headers: KeyValue[];
  partition?: number;
}

export interface KafkaPresetConsume {
  groupId: string;
  topics: string[];
  mode: KafkaPresetConsumeMode;
}

export interface KafkaRequest {
  id: string;
  name: string;
  type: 'kafka';
  description?: string;
  connection: KafkaPresetConnection;
  produce: KafkaPresetProduce;
  consume: KafkaPresetConsume;
}

export type MqttPresetQoS = 0 | 1 | 2;

export interface MqttPresetConnection {
  brokerUrl: string;
  /** 4 = MQTT 3.1.1, 5 = MQTT 5.0. */
  protocolVersion: 4 | 5;
  clientId: string;
  keepalive: number;
  cleanStart: boolean;
  connectTimeout: number;
  autoReconnect: boolean;
  /** Username only — the password is a local secret. */
  username?: string;
  tls?: BrokerPresetTls;
  lwt?: { topic: string; payload: string; qos: MqttPresetQoS; retain: boolean };
  sessionExpiryInterval?: number;
}

/** A saved MQTT publish (mirrors the connection's message templates). */
export interface MqttPresetPublish {
  name: string;
  topic: string;
  payload: string;
  qos: MqttPresetQoS;
  retain: boolean;
  contentType?: string;
  responseTopic?: string;
  /** MQTT 5 user properties. */
  userProperties?: Record<string, string>;
}

export interface MqttRequest {
  id: string;
  name: string;
  type: 'mqtt';
  description?: string;
  connection: MqttPresetConnection;
  /** Composer draft: the publish the panel opens with. */
  publish: Omit<MqttPresetPublish, 'name'>;
  /** Composer draft: the topic filter the subscribe form opens with. */
  subscribe: { topicFilter: string; qos: MqttPresetQoS };
  /** Saved publishes, stored unresolved. */
  templates: MqttPresetPublish[];
}

export type BrokerRequest = KafkaRequest | MqttRequest;
export type BrokerRequestType = BrokerRequest['type'];

export function isBrokerRequest(request: { type: string } | undefined): request is BrokerRequest {
  return request?.type === 'kafka' || request?.type === 'mqtt';
}
