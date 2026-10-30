// Kafka IPC types (`window.electron.kafka`).

import type { ProtocolSecretValue } from './shared';

export type KafkaSaslMechanism =
  | 'PLAIN'
  | 'SCRAM-SHA-256'
  | 'SCRAM-SHA-512'
  | 'OAUTHBEARER'
  | 'GSSAPI'
  | 'AWS_MSK_IAM';

/**
 * TLS material for a Kafka connection. The renderer sends file PATHS; main
 * reads them (allowlisted, size-capped) so PEM / key material never transits
 * the renderer (SEC-K3). Inline `ca`/`cert`/`key` stay accepted for
 * programmatic callers.
 */
export interface KafkaTlsIpc {
  ca?: string;
  cert?: string;
  key?: string;
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  /** SecretValue — the connection's broker-secret handle, resolved in main. */
  passphrase?: ProtocolSecretValue;
  rejectUnauthorized?: boolean;
}

export type KafkaSaslIpc =
  | {
      mechanism: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';
      username: string;
      /** SecretValue — the connection's broker-secret handle, resolved in main. */
      password: ProtocolSecretValue;
    }
  | {
      mechanism: 'OAUTHBEARER';
      mode?: 'static';
      /** SecretValue — the connection's broker-secret handle, resolved in main. */
      token: ProtocolSecretValue;
      extensions?: Record<string, string>;
    }
  | {
      // OAuth 2.0 client-credentials — main fetches + refreshes the token.
      mechanism: 'OAUTHBEARER';
      mode: 'client-credentials';
      tokenEndpoint: string;
      clientId: string;
      /** SecretValue (ADR-0007) — resolved to plaintext in the main process. */
      clientSecret: ProtocolSecretValue;
      scope?: string;
      extensions?: Record<string, string>;
    }
  | { mechanism: 'GSSAPI'; serviceName?: string; principal?: string }
  | {
      mechanism: 'AWS_MSK_IAM';
      region: string;
      /** Opt-in: allow brokers outside *.kafka.<region>.amazonaws.com (PrivateLink / custom DNS). */
      allowNonAwsBrokerHosts?: boolean;
      credentials:
        | {
            source: 'static';
            accessKeyId: string;
            /** SecretValue (ADR-0007) — resolved to plaintext in the main process. */
            secretAccessKey: ProtocolSecretValue;
            sessionToken?: ProtocolSecretValue;
          }
        | { source: 'profile'; profile: string };
    };

export type KafkaAuthIpc =
  | { securityProtocol: 'PLAINTEXT' }
  | {
      securityProtocol: 'SASL_PLAINTEXT';
      sasl: KafkaSaslIpc;
    }
  | {
      securityProtocol: 'SASL_SSL';
      sasl: KafkaSaslIpc;
      tls?: KafkaTlsIpc;
    }
  | { securityProtocol: 'SSL'; tls: KafkaTlsIpc };

/**
 * Confluent Schema Registry config. The Basic password and a bearer token are
 * SecretValues — stored credentials cross IPC as the connection's broker-secret
 * handle and keychain handles / external refs are resolved only in main.
 * Registry HTTPS uses the execution policy's TLS selection (CA, mTLS, verify).
 */
export type KafkaRegistryAuthIpc =
  | { type?: 'basic'; username?: string; password?: ProtocolSecretValue }
  | { type: 'bearer'; token: ProtocolSecretValue };

export interface KafkaRegistryIpc {
  url: string;
  auth?: KafkaRegistryAuthIpc;
}

export type KafkaRegistryVersionIpc = number | 'latest';
export type KafkaRegistrySchemaType = 'AVRO' | 'JSON' | 'PROTOBUF';

export interface KafkaRegistrySchemaIpc {
  id: number;
  subject: string;
  version: number;
  schemaType: KafkaRegistrySchemaType;
  schema: string;
  references: { name: string; subject: string; version: number }[];
}

/** Registry schema that decoded a consumed field (subject/version when resolvable). */
export interface KafkaSchemaRefIpc {
  id: number;
  subject?: string;
  version?: number;
}

export interface KafkaAck {
  topic: string;
  partition: number;
  offset: string;
  timestamp: number;
}

export type KafkaDataFieldIpc =
  | { encoding: 'utf8'; data: string }
  | { encoding: 'base64'; data: string };

export type KafkaRecordFieldIpc =
  | KafkaDataFieldIpc
  | { encoding: 'schema'; schemaId: number; data: string }
  | { encoding: 'schema'; subject: string; version: KafkaRegistryVersionIpc; data: string }
  | { encoding: 'null' };

export interface KafkaRecordIpc {
  topic: string;
  key?: KafkaRecordFieldIpc;
  value: KafkaRecordFieldIpc;
  headers?: { key: KafkaDataFieldIpc; value: KafkaDataFieldIpc }[];
  partition?: number;
  /** Epoch milliseconds as a numeric string to preserve bigint precision over IPC. */
  timestamp?: string;
}

export interface KafkaSendOptionsIpc {
  connectionId: string;
  acks: 0 | 1 | -1;
  compression?: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
}

/** Per-partition starting offset for MANUAL consume mode (offset is a numeric string). */
export interface KafkaPartitionOffset {
  topic: string;
  partition: number;
  offset: string;
}

/** A topic partition addressed by a live-consumer control (pause/resume/seek). */
export interface KafkaTopicPartition {
  topic: string;
  partition: number;
}

/** Result of a partition pause/resume: the partitions still paused afterwards. */
export interface KafkaPartitionControlResult {
  success: boolean;
  error?: string;
  pausedPartitions?: KafkaTopicPartition[];
}

/** Where a live seek lands: an exact offset, or the first record at/after a timestamp (epoch ms). */
export type KafkaSeekTarget =
  | { kind: 'offset'; offset: string }
  | { kind: 'timestamp'; timestamp: string };

/** A consumer group as returned by Admin.listGroups (Map flattened to an array). */
export interface KafkaGroupInfo {
  id: string;
  state: string;
  groupType: string;
  protocolType: string;
}

/** Per-partition watermarks for a topic (offsets are numeric strings). */
export interface KafkaPartitionWatermark {
  partition: number;
  low: string;
  high: string;
  count: string;
}

/** A single topic config entry (Admin.describeConfigs, flattened). */
export interface KafkaTopicConfigEntry {
  name: string;
  value: string | null;
  source: string;
  isDefault: boolean;
  isSensitive: boolean;
  readOnly: boolean;
}

/** A consumer-group member with its partition assignments. */
export interface KafkaGroupMemberInfo {
  memberId: string;
  clientId: string;
  clientHost: string;
  assignments: { topic: string; partitions: number[] }[];
}

/** A consumer group's describe output (Admin.describeGroups, flattened). */
export interface KafkaGroupDescription {
  id: string;
  state: string;
  protocol: string;
  protocolType: string;
  members: KafkaGroupMemberInfo[];
}

/** Per-partition committed offset + log-end + computed lag for a group. */
export interface KafkaPartitionLag {
  topic: string;
  partition: number;
  /** Committed offset, or null when the group has not committed this partition. */
  committed: string | null;
  logEnd: string;
  lag: string;
}

export type KafkaOffsetResetTarget = 'earliest' | 'latest' | 'specific' | 'timestamp' | 'shift';

/** One partition of an offset-reset plan/result. */
export interface KafkaOffsetResetRow {
  topic: string;
  partition: number;
  /** Committed offset before the reset, or null when none was committed. */
  previous: string | null;
  offset: string;
  /** Why the target differs from the literal request (timestamp fallback / shift clamp). */
  note?: 'timestamp-fallback-latest' | 'clamped-earliest' | 'clamped-latest';
}

/**
 * A partition left untouched: a shift reset with no committed offset to move, or
 * (all-topics scope) a committed topic that has since been deleted.
 */
export interface KafkaOffsetResetSkip {
  topic: string;
  partition: number;
  reason: 'no-committed-offset' | 'unknown-topic';
}

export interface ElectronKafkaAPI {
  connect: (config: {
    connectionId: string;
    clientId: string;
    bootstrapBrokers: string[];
    auth: KafkaAuthIpc;
    /** Enable the idempotent producer (forces acks=-1 on the produce path). */
    idempotent?: boolean;
    /** Stable identifier required for producer transaction sessions. */
    transactionalId?: string;
    /** Confluent Schema Registry — when set, the consumer decodes via it. */
    registry?: KafkaRegistryIpc;
  }) => Promise<{ success: boolean; error?: string }>;
  produce: (
    config: KafkaSendOptionsIpc & { record: KafkaRecordIpc }
  ) => Promise<{ success: boolean; ack?: KafkaAck; error?: string }>;
  produceBatch: (
    config: KafkaSendOptionsIpc & { records: KafkaRecordIpc[] }
  ) => Promise<{ success: boolean; acks?: KafkaAck[]; error?: string }>;
  openProducerStream: (
    config: KafkaSendOptionsIpc & {
      highWaterMark?: number;
      batchSize?: number;
      batchTime?: number;
    }
  ) => Promise<{ success: boolean; error?: string }>;
  writeProducerStream: (config: {
    connectionId: string;
    record: KafkaRecordIpc;
  }) => Promise<{ success: boolean; accepted?: boolean; error?: string }>;
  closeProducerStream: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  beginTransaction: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; transactionId?: string; error?: string }>;
  endTransaction: (config: {
    connectionId: string;
    action: 'commit' | 'abort';
  }) => Promise<{ success: boolean; error?: string }>;
  subscribe: (config: {
    connectionId: string;
    /** `browse` = no consumer group, no commits (#930). Omitted means `group`. */
    membership?: 'browse' | 'group';
    /** Required in group mode; must be omitted in browse mode. */
    groupId?: string;
    topics: string[];
    mode: 'committed' | 'latest' | 'earliest' | 'manual' | 'timestamp' | 'last-n';
    /** Browse `last-n` start: records per partition. */
    lastN?: number;
    /** Browse only: stop after this many records in total. */
    maxMessages?: number;
    fallbackMode?: 'latest' | 'earliest' | 'fail';
    offsets?: KafkaPartitionOffset[];
    timestamp?: string;
    commitPolicy?: 'auto' | 'manual';
    autoCommitIntervalMs?: number;
    isolation?: 'read-uncommitted' | 'read-committed';
    groupProtocol?: 'classic' | 'consumer';
    groupInstanceId?: string;
    groupRemoteAssignor?: string;
    sessionTimeoutMs?: number;
    rebalanceTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    minBytes?: number;
    maxBytes?: number;
    maxBytesPerPartition?: number;
    maxWaitTimeMs?: number;
    highWaterMark?: number;
    lagIntervalMs?: number;
  }) => Promise<{ success: boolean; error?: string }>;
  pauseConsumer: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  resumeConsumer: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  /** Withhold records from these partitions; the rest of the subscription keeps flowing. */
  pausePartitions: (config: {
    connectionId: string;
    partitions: KafkaTopicPartition[];
  }) => Promise<KafkaPartitionControlResult>;
  /** Resume paused partitions from the first record withheld while they were paused. */
  resumePartitions: (config: {
    connectionId: string;
    partitions: KafkaTopicPartition[];
  }) => Promise<KafkaPartitionControlResult>;
  /** Reposition one partition of the live consumer; resolves with the offset it landed on. */
  seekConsumer: (config: {
    connectionId: string;
    topic: string;
    partition: number;
    target: KafkaSeekTarget;
  }) => Promise<{ success: boolean; error?: string; offset?: string }>;
  commitMessage: (config: {
    connectionId: string;
    commitToken: string;
  }) => Promise<{ success: boolean; error?: string }>;
  unsubscribe: (config: { connectionId: string }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  // Admin (topic + consumer-group management). Each constructs a short-lived
  // Admin client from the live connection's auth/TLS.
  listTopics: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; topics?: string[]; error?: string }>;
  createTopic: (config: {
    connectionId: string;
    topic: string;
    partitions: number;
    replicationFactor: number;
  }) => Promise<{ success: boolean; error?: string }>;
  deleteTopic: (config: {
    connectionId: string;
    topic: string;
  }) => Promise<{ success: boolean; error?: string }>;
  listGroups: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; groups?: KafkaGroupInfo[]; error?: string }>;
  /** Topic inspector: per-partition watermarks + topic config. */
  inspectTopic: (config: { connectionId: string; topic: string }) => Promise<{
    success: boolean;
    partitions?: KafkaPartitionWatermark[];
    config?: KafkaTopicConfigEntry[];
    error?: string;
  }>;
  /** Consumer-group inspector: members/state + committed offsets + computed lag. */
  inspectGroup: (config: { connectionId: string; groupId: string }) => Promise<{
    success: boolean;
    group?: KafkaGroupDescription | null;
    offsets?: KafkaPartitionLag[];
    error?: string;
  }>;
  /**
   * Reset a group's committed offsets for one topic or all committed topics
   * (group must be inactive). `dryRun` returns the plan without committing it.
   */
  resetGroupOffsets: (config: {
    connectionId: string;
    groupId: string;
    topic?: string;
    allTopics?: boolean;
    to: KafkaOffsetResetTarget;
    partitions?: { partition: number; offset: string }[];
    /** Epoch milliseconds, for `to: 'timestamp'`. */
    timestamp?: number;
    /** Relative move (±N), for `to: 'shift'`. */
    shift?: number;
    dryRun?: boolean;
  }) => Promise<{
    success: boolean;
    offsets?: KafkaOffsetResetRow[];
    skipped?: KafkaOffsetResetSkip[];
    dryRun?: boolean;
    error?: string;
  }>;
  /** Delete a group's committed offsets (KIP-496 OffsetDelete; group must be inactive). */
  deleteGroupOffsets: (config: {
    connectionId: string;
    groupId: string;
    topic?: string;
    allTopics?: boolean;
    partitions?: number[];
  }) => Promise<{
    success: boolean;
    deleted?: { topic: string; partitions: number[] }[];
    skipped?: KafkaOffsetResetSkip[];
    error?: string;
  }>;
  /** Delete a consumer group (group must be empty/inactive). */
  deleteGroup: (config: {
    connectionId: string;
    groupId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  createPartitions: (config: {
    connectionId: string;
    topic: string;
    count: number;
    validateOnly: boolean;
    confirmation?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  alterTopicConfigs: (config: {
    connectionId: string;
    topic: string;
    configs: {
      name: string;
      operation: 'set' | 'delete' | 'append' | 'subtract';
      value?: string;
    }[];
    validateOnly: boolean;
    confirmation?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  deleteRecords: (config: {
    connectionId: string;
    topic: string;
    partitions: { partition: number; offset: string }[];
    confirmation: string;
  }) => Promise<{
    success: boolean;
    lowWatermarks?: { partition: number; offset: string }[];
    error?: string;
  }>;
  describeCluster: (config: { connectionId: string }) => Promise<{
    success: boolean;
    cluster?: {
      id: string;
      controllerId: number;
      brokers: { id: number; host: string; port: number; rack: string | null }[];
      topics: { name: string; partitions: number }[];
    };
    error?: string;
  }>;
  describeAcls: (config: { connectionId: string; filter: KafkaAclIpc }) => Promise<{
    success: boolean;
    acls?: unknown[];
    error?: string;
  }>;
  createAcl: (config: {
    connectionId: string;
    acl: KafkaAclIpc;
    confirmation: string;
  }) => Promise<{ success: boolean; error?: string }>;
  deleteAcls: (config: {
    connectionId: string;
    filter: KafkaAclIpc;
    confirmation: string;
  }) => Promise<{ success: boolean; deleted?: unknown[]; error?: string }>;
  describeQuotas: (config: {
    connectionId: string;
    entities: KafkaQuotaEntityIpc[];
  }) => Promise<{ success: boolean; quotas?: unknown[]; error?: string }>;
  alterQuotas: (config: {
    connectionId: string;
    entities: KafkaQuotaEntityIpc[];
    operations: {
      key: 'producer_byte_rate' | 'consumer_byte_rate' | 'request_percentage';
      value?: number;
      remove: boolean;
    }[];
    validateOnly: boolean;
    confirmation?: string;
  }) => Promise<{ success: boolean; results?: unknown[]; error?: string }>;
  // Schema Registry browsing (subject picker / schema viewer).
  registryListSubjects: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; subjects?: string[]; error?: string }>;
  registryListVersions: (config: {
    connectionId: string;
    subject: string;
  }) => Promise<{ success: boolean; versions?: number[]; error?: string }>;
  registryGetSchema: (config: {
    connectionId: string;
    subject: string;
    version: KafkaRegistryVersionIpc;
  }) => Promise<{ success: boolean; schema?: KafkaRegistrySchemaIpc; error?: string }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface KafkaAclIpc {
  resourceType: number;
  resourceName?: string | null;
  resourcePatternType: number;
  principal?: string | null;
  host?: string | null;
  operation: number;
  permissionType: number;
}

export interface KafkaQuotaEntityIpc {
  entityType: 'user' | 'client-id';
  entityName?: string | null;
}
