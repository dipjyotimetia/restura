import { type KafkaSecretField, kafkaSecretStorageKey } from '@shared/protocol/broker-secret-id';
import type { ProtocolSecretValue } from '@shared/protocol/types';
import {
  KAFKA_FLUSH_INTERVAL_MS,
  type KafkaConsumedPayload,
  toReceivedMessage,
} from '@/features/kafka/lib/consumedMessageBuffer';
import type {
  KafkaAuth,
  KafkaCompression,
  KafkaConnection,
  KafkaMessageInput,
  KafkaRegistry,
  KafkaSasl,
} from '@/features/kafka/store/useKafkaStore';
import {
  isKafkaPasswordSasl,
  isKafkaStaticOAuthSasl,
  KAFKA_SECRET_SENTINEL,
  onKafkaMessagesCleared,
  useKafkaStore,
} from '@/features/kafka/store/useKafkaStore';
import { brokerSecretRef, ensureBrokerSecret } from '@/lib/shared/broker-secrets';
import { MAX_MESSAGES_PER_CONNECTION } from '@/lib/shared/message-cap';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import type { SecretRef } from '@/lib/shared/secretRef';
import { createChannelBinder } from '@/lib/shared/streaming/channelBinding';
import { CoalescingBuffer } from '@/lib/shared/streaming/coalescingBuffer';
import { connectionChannels } from '@/lib/shared/streaming/desktopStreamAdapter';
import { EVENT_PREFIX } from '../../../../electron/shared/channels';
import type {
  ElectronKafkaAPI,
  KafkaAuthIpc,
  KafkaGroupDescription,
  KafkaGroupInfo,
  KafkaOffsetResetRow,
  KafkaOffsetResetSkip,
  KafkaPartitionLag,
  KafkaPartitionWatermark,
  KafkaRecordFieldIpc,
  KafkaRegistryIpc,
  KafkaSaslIpc,
  KafkaTlsIpc,
  KafkaTopicConfigEntry,
} from '../../../../electron/types/electron-api';
import { isKafkaBrowse, type KafkaSubscribePayload, toBrowseSubscribe } from './kafkaBrowse';

type KafkaEventKind = keyof typeof EVENT_PREFIX.kafka;

/** Everything but `message`, which is bound per subscribe. `connected` is never listened to but is cleared with the rest. */
const LIFECYCLE_KINDS = [
  'close',
  'error',
  'consumerClosed',
  'consumerStatus',
  'consumerLag',
  'connected',
] as const satisfies readonly KafkaEventKind[];

function kafkaChannels<K extends KafkaEventKind>(
  connectionId: string,
  kinds: readonly K[]
): Record<K, string> {
  const prefixes = {} as Record<K, string>;
  for (const kind of kinds) prefixes[kind] = EVENT_PREFIX.kafka[kind];
  return connectionChannels(prefixes, connectionId);
}

export type KafkaResetGroupOffsetsParams = Parameters<ElectronKafkaAPI['resetGroupOffsets']>[0];
export type KafkaDeleteGroupOffsetsParams = Parameters<ElectronKafkaAPI['deleteGroupOffsets']>[0];

export type { KafkaSecretField };

export function kafkaSecretKey(connectionId: string, field: KafkaSecretField): string {
  // Every field name matches a secureStorage sensitive-key pattern
  // (`password`/`token`/`passphrase`), so a legacy pre-handle value lives in
  // electron-store + safeStorage, never plaintext localStorage.
  return kafkaSecretStorageKey(connectionId, field);
}

/**
 * A sentinel-marked field means "stored in the main-process handle for this
 * key" (SEC-K3). Returns the handle reference to send over IPC — never the
 * plaintext — or null when nothing is stored (legacy secureStorage values are
 * migrated into the handle on first use).
 */
async function storedSecretRef(
  connectionId: string,
  field: KafkaSecretField
): Promise<SecretRef | null> {
  const key = kafkaSecretKey(connectionId, field);
  return (await ensureBrokerSecret(key)) ? brokerSecretRef(key) : null;
}

/**
 * Resolve the persisted registry config into the IPC shape: sentinel-marked
 * secrets become the connection's broker-secret handle (resolved in main).
 * Returns undefined when no registry is configured.
 */
export async function resolveRegistry(
  connectionId: string,
  registry: KafkaRegistry | undefined
): Promise<KafkaRegistryIpc | undefined> {
  if (!registry) return undefined;
  const out: KafkaRegistryIpc = { url: registry.url };
  if (registry.authType === 'bearer') {
    // Handles / external refs cross IPC as references and resolve only in main.
    const stored = registry.bearerToken;
    const token =
      stored === KAFKA_SECRET_SENTINEL
        ? await storedSecretRef(connectionId, 'registry-token')
        : stored;
    if (!token || (typeof token === 'object' && token.kind === 'inline' && !token.value)) {
      throw new Error('Missing Schema Registry bearer token — re-enter it.');
    }
    out.auth = { type: 'bearer', token };
    return out;
  }
  if (registry.auth) {
    // A sentinel means the value lives in the handle for this field; otherwise
    // it's the inline value (or undefined).
    const auth: { username?: string; password?: ProtocolSecretValue } = {};
    if (registry.auth.username) auth.username = registry.auth.username;
    const stored = registry.auth.password;
    const password =
      stored === KAFKA_SECRET_SENTINEL
        ? await storedSecretRef(connectionId, 'registry-password')
        : stored || null;
    if (password) auth.password = password;
    if (Object.keys(auth).length > 0) out.auth = auth;
  }
  return out;
}

/**
 * Resolve the persisted SASL block into its IPC shape. Sentinel-marked
 * password / static-token secrets go as the connection's broker-secret handle;
 * SecretRef handles for OAuth client secrets and AWS keys are forwarded as
 * handles. Both resolve only in main. Returns null when a required credential
 * is missing.
 */
async function resolveSasl(connectionId: string, sasl: KafkaSasl): Promise<KafkaSaslIpc | null> {
  if (isKafkaPasswordSasl(sasl)) {
    const password =
      sasl.password === KAFKA_SECRET_SENTINEL
        ? await storedSecretRef(connectionId, 'sasl-password')
        : sasl.password;
    return password ? { mechanism: sasl.mechanism, username: sasl.username, password } : null;
  }
  if (isKafkaStaticOAuthSasl(sasl)) {
    const token =
      sasl.token === KAFKA_SECRET_SENTINEL
        ? await storedSecretRef(connectionId, 'oauth-token')
        : sasl.token;
    if (!token) return null;
    return {
      mechanism: 'OAUTHBEARER',
      token,
      ...(sasl.extensions ? { extensions: sasl.extensions } : {}),
    };
  }
  if (sasl.mechanism === 'OAUTHBEARER') {
    const tokenEndpoint = sasl.tokenEndpoint.trim();
    const clientId = sasl.clientId.trim();
    if (!tokenEndpoint || !clientId || !sasl.clientSecret) return null;
    return {
      mechanism: 'OAUTHBEARER',
      mode: 'client-credentials',
      tokenEndpoint,
      clientId,
      clientSecret: sasl.clientSecret,
      ...(sasl.scope?.trim() ? { scope: sasl.scope.trim() } : {}),
      ...(sasl.extensions ? { extensions: sasl.extensions } : {}),
    };
  }
  if (sasl.mechanism === 'GSSAPI') {
    return {
      mechanism: 'GSSAPI',
      ...(sasl.serviceName?.trim() ? { serviceName: sasl.serviceName.trim() } : {}),
      ...(sasl.principal?.trim() ? { principal: sasl.principal.trim() } : {}),
    };
  }
  const region = sasl.region.trim();
  if (!region) return null;
  const optIn = sasl.allowNonAwsBrokerHosts === true ? { allowNonAwsBrokerHosts: true } : {};
  if (sasl.credentialSource === 'profile') {
    const profile = sasl.profile?.trim();
    return profile
      ? {
          mechanism: 'AWS_MSK_IAM',
          region,
          ...optIn,
          credentials: { source: 'profile', profile },
        }
      : null;
  }
  const accessKeyId = sasl.accessKeyId?.trim();
  if (!accessKeyId || !sasl.secretAccessKey) return null;
  return {
    mechanism: 'AWS_MSK_IAM',
    region,
    ...optIn,
    credentials: {
      source: 'static',
      accessKeyId,
      secretAccessKey: sasl.secretAccessKey,
      ...(sasl.sessionToken ? { sessionToken: sasl.sessionToken } : {}),
    },
  };
}

/**
 * Resolve the persisted KafkaAuth into the IPC shape. Secrets go as
 * broker-secret handles and TLS material as file PATHS — main reads the files
 * (allowlisted) so key material never transits the renderer (SEC-K3).
 */
async function resolveAuth(connectionId: string, auth: KafkaAuth): Promise<KafkaAuthIpc | null> {
  if (auth.securityProtocol === 'PLAINTEXT') {
    return { securityProtocol: 'PLAINTEXT' };
  }

  // Resolve TLS once — used by SASL_SSL and SSL.
  let tlsIpc: KafkaTlsIpc | undefined;
  if (auth.tls) {
    const { caPath, certPath, keyPath, passphrase, rejectUnauthorized } = auth.tls;
    tlsIpc = {
      ...(rejectUnauthorized !== undefined ? { rejectUnauthorized } : {}),
      ...(caPath ? { caPath } : {}),
      ...(certPath ? { certPath } : {}),
      ...(keyPath ? { keyPath } : {}),
    };
    if (passphrase === KAFKA_SECRET_SENTINEL) {
      const ref = await storedSecretRef(connectionId, 'tls-passphrase');
      if (ref) tlsIpc.passphrase = ref;
    } else if (passphrase) {
      tlsIpc.passphrase = passphrase;
    }
  }

  if (auth.securityProtocol === 'SSL') {
    return { securityProtocol: 'SSL', tls: tlsIpc ?? {} };
  }

  if (!auth.sasl) return null;
  const sasl = await resolveSasl(connectionId, auth.sasl);
  if (!sasl) return null;

  if (auth.securityProtocol === 'SASL_PLAINTEXT') {
    return { securityProtocol: 'SASL_PLAINTEXT', sasl };
  }
  return { securityProtocol: 'SASL_SSL', sasl, ...(tlsIpc ? { tls: tlsIpc } : {}) };
}

export interface KafkaSubjectSelection {
  subject: string;
  version: number | 'latest';
}

/** Schema-encoded IPC field: by subject + version when chosen, else by numeric id. */
function schemaField(
  data: string,
  schemaId: number | undefined,
  subject: KafkaSubjectSelection | undefined
): KafkaRecordFieldIpc | undefined {
  if (subject)
    return { encoding: 'schema', subject: subject.subject, version: subject.version, data };
  if (schemaId !== undefined) return { encoding: 'schema', schemaId, data };
  return undefined;
}

class KafkaManager {
  private subscribed: Set<string> = new Set();
  /** Batches consumed records into one store update per connection per tick. */
  private inbound = new CoalescingBuffer<KafkaMessageInput>(
    (connectionId, batch) => useKafkaStore.getState().addMessages(connectionId, batch),
    { intervalMs: KAFKA_FLUSH_INTERVAL_MS, maxBuffered: MAX_MESSAGES_PER_CONNECTION }
  );
  private lifecycle = createChannelBinder({
    bridge: () => getElectronAPI()?.kafka,
    channels: (id) => kafkaChannels(id, LIFECYCLE_KINDS),
  });
  /** Separate from `lifecycle`: it is bound per subscribe, and drains the buffer on detach. */
  private messages = createChannelBinder({
    bridge: () => getElectronAPI()?.kafka,
    channels: (id) => kafkaChannels(id, ['message']),
    drain: (id) => this.inbound.flush(id),
  });
  constructor() {
    // Clearing the log must also drop records still waiting for the next flush.
    onKafkaMessagesCleared((id) => this.inbound.discard(id));
  }

  async connect(connection: KafkaConnection): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) {
      return { ok: false, error: 'Kafka is only available in the Restura desktop app.' };
    }
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useKafkaStore.getState();
    store.updateStatus(connection.id, 'connecting');

    let ipcAuth: KafkaAuthIpc | null;
    let registry: KafkaRegistryIpc | undefined;
    try {
      ipcAuth = await resolveAuth(connection.id, connection.auth);
      registry = await resolveRegistry(connection.id, connection.registry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to resolve Kafka credentials';
      store.updateStatus(connection.id, 'disconnected');
      store.addMessage(connection.id, { direction: 'system', topic: '', value: msg, error: msg });
      return { ok: false, error: msg };
    }
    if (!ipcAuth) {
      store.updateStatus(connection.id, 'disconnected');
      const msg = 'Missing SASL credentials or TLS material — re-enter credentials.';
      store.addMessage(connection.id, { direction: 'system', topic: '', value: msg, error: msg });
      return { ok: false, error: msg };
    }

    // Reconnecting with the same id must replace, not stack, renderer event
    // handlers. Otherwise every broker event is processed once per prior
    // connection attempt.
    this.bindLifecycleListeners(connection.id);

    let result: Awaited<ReturnType<typeof api.kafka.connect>>;
    try {
      result = await api.kafka.connect({
        connectionId: connection.id,
        clientId: connection.clientId,
        bootstrapBrokers: connection.bootstrapBrokers,
        auth: ipcAuth,
        ...(connection.idempotent ? { idempotent: true } : {}),
        ...(connection.transactionalId ? { transactionalId: connection.transactionalId } : {}),
        ...(registry ? { registry } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Kafka connect failed';
      store.updateStatus(connection.id, 'disconnected');
      store.addMessage(connection.id, { direction: 'system', topic: '', value: msg, error: msg });
      this.lifecycle.unbind(connection.id);
      return { ok: false, error: msg };
    }

    if (!result.success) {
      store.updateStatus(connection.id, 'disconnected');
      const msg = result.error ?? 'Kafka connect failed';
      store.addMessage(connection.id, { direction: 'system', topic: '', value: msg, error: msg });
      this.lifecycle.unbind(connection.id);
      return { ok: false, error: msg };
    }

    store.updateStatus(connection.id, 'connected');
    store.addMessage(connection.id, {
      direction: 'system',
      topic: '',
      value: `Connected to ${connection.bootstrapBrokers.join(', ')}`,
    });
    return { ok: true };
  }

  async produce(params: {
    connectionId: string;
    topic: string;
    key?: string;
    keyEncoding?: 'utf8' | 'base64';
    value: string | null;
    valueEncoding?: 'utf8' | 'base64';
    headers?: Record<string, string>;
    partition?: number;
    acks: 0 | 1 | -1;
    compression?: KafkaCompression;
    valueSchemaId?: number;
    keySchemaId?: number;
    /** Transcript copy with secret `{{var}}` values masked (kafkaVariables.ts). */
    display?: { key?: string; value?: string; headers?: Record<string, string> };
    /** Subject + version alternative to a numeric schema id (resolved in main). */
    valueSubject?: KafkaSubjectSelection;
    keySubject?: KafkaSubjectSelection;
  }): Promise<
    | { ok: true; ack: { topic: string; partition: number; offset: string; timestamp: number } }
    | { ok: false; error: string }
  > {
    if (!isElectron()) return { ok: false, error: 'Kafka is desktop-only.' };
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useKafkaStore.getState();
    const result = await api.kafka.produce({
      connectionId: params.connectionId,
      record: {
        topic: params.topic,
        ...(params.key !== undefined
          ? {
              key:
                schemaField(params.key, params.keySchemaId, params.keySubject) ??
                ({ encoding: params.keyEncoding ?? 'utf8', data: params.key } as const),
            }
          : {}),
        value:
          params.value === null
            ? { encoding: 'null' }
            : (schemaField(params.value, params.valueSchemaId, params.valueSubject) ?? {
                encoding: params.valueEncoding ?? 'utf8',
                data: params.value,
              }),
        ...(params.headers
          ? {
              headers: Object.entries(params.headers).map(([key, value]) => ({
                key: { encoding: 'utf8' as const, data: key },
                value: { encoding: 'utf8' as const, data: value },
              })),
            }
          : {}),
        ...(params.partition !== undefined ? { partition: params.partition } : {}),
      },
      acks: params.acks,
      ...(params.compression && params.compression !== 'none'
        ? { compression: params.compression }
        : {}),
    });

    if (!result.success || !result.ack) {
      const msg = result.error ?? 'Produce failed';
      store.addMessage(params.connectionId, {
        direction: 'system',
        topic: params.topic,
        value: msg,
        error: msg,
      });
      return { ok: false, error: msg };
    }

    store.addMessage(params.connectionId, {
      direction: 'sent',
      topic: result.ack.topic,
      partition: result.ack.partition,
      offset: result.ack.offset,
      ...(params.key !== undefined ? { key: params.display?.key ?? params.key } : {}),
      ...(params.keyEncoding !== undefined ? { keyEncoding: params.keyEncoding } : {}),
      value: params.value === null ? '<tombstone>' : (params.display?.value ?? params.value),
      ...(params.value === null ? { tombstone: true } : {}),
      ...(params.valueEncoding !== undefined ? { valueEncoding: params.valueEncoding } : {}),
      ...(params.headers ? { headers: params.display?.headers ?? params.headers } : {}),
    });
    return { ok: true, ack: result.ack };
  }

  async subscribe(params: {
    connectionId: string;
    groupId: string;
    topics: string[];
    fromBeginning: boolean;
    mode?: 'committed' | 'latest' | 'earliest' | 'manual' | 'timestamp' | 'last-n';
    offsets?: Array<{ topic: string; partition: number; offset: string }>;
    timestamp?: string;
    /** Unresolved `{{var}}` forms to persist instead of the wire values (#984). */
    stored?: { groupId: string; topics: string[] };
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) return { ok: false, error: 'Kafka is desktop-only.' };
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useKafkaStore.getState();
    // The persisted consumer state only tracks groupId/topics/fromBeginning;
    // mode/offsets are transient subscribe-time inputs, so don't push them there.
    store.updateConsumer(params.connectionId, {
      status: 'subscribing',
      groupId: params.stored?.groupId ?? params.groupId,
      topics: params.stored?.topics ?? params.topics,
      fromBeginning: params.fromBeginning,
    });
    this.bindMessageListener(params.connectionId);

    const consumer = store.connections[params.connectionId]?.consumer;
    const payload: KafkaSubscribePayload = {
      connectionId: params.connectionId,
      groupId: params.groupId,
      topics: params.topics,
      mode: params.mode ?? consumer?.mode ?? (params.fromBeginning ? 'earliest' : 'latest'),
      fallbackMode: consumer?.fallbackMode ?? 'latest',
      commitPolicy: consumer?.commitPolicy ?? 'auto',
      isolation: consumer?.isolation ?? 'read-uncommitted',
      groupProtocol: consumer?.groupProtocol ?? 'classic',
      lagIntervalMs: 1000,
      ...(consumer?.groupInstanceId ? { groupInstanceId: consumer.groupInstanceId } : {}),
      ...(consumer?.groupRemoteAssignor
        ? { groupRemoteAssignor: consumer.groupRemoteAssignor }
        : {}),
      ...(consumer?.sessionTimeoutMs ? { sessionTimeoutMs: consumer.sessionTimeoutMs } : {}),
      ...(consumer?.rebalanceTimeoutMs ? { rebalanceTimeoutMs: consumer.rebalanceTimeoutMs } : {}),
      ...(consumer?.heartbeatIntervalMs
        ? { heartbeatIntervalMs: consumer.heartbeatIntervalMs }
        : {}),
      ...(consumer?.autoCommitIntervalMs
        ? { autoCommitIntervalMs: consumer.autoCommitIntervalMs }
        : {}),
      ...(consumer?.minBytes !== undefined ? { minBytes: consumer.minBytes } : {}),
      ...(consumer?.maxBytes ? { maxBytes: consumer.maxBytes } : {}),
      ...(consumer?.maxBytesPerPartition
        ? { maxBytesPerPartition: consumer.maxBytesPerPartition }
        : {}),
      ...(consumer?.maxWaitTimeMs !== undefined ? { maxWaitTimeMs: consumer.maxWaitTimeMs } : {}),
      ...(consumer?.highWaterMark ? { highWaterMark: consumer.highWaterMark } : {}),
      ...(params.offsets ? { offsets: params.offsets } : {}),
      ...(params.timestamp ? { timestamp: params.timestamp } : {}),
    };
    const browse = isKafkaBrowse(consumer);
    const result = await api.kafka.subscribe(
      browse ? toBrowseSubscribe(payload, consumer ?? {}) : payload
    );
    if (!result.success) {
      store.updateConsumer(params.connectionId, { status: 'error' });
      const msg = result.error ?? 'Subscribe failed';
      store.addMessage(params.connectionId, {
        direction: 'system',
        topic: '',
        value: msg,
        error: msg,
      });
      this.unbindMessageListener(params.connectionId);
      return { ok: false, error: msg };
    }

    this.subscribed.add(params.connectionId);
    store.updateConsumer(params.connectionId, { status: 'subscribed' });
    store.addMessage(params.connectionId, {
      direction: 'system',
      topic: params.topics.join(','),
      value: browse
        ? `Browsing ${params.topics.join(', ')} (read-only, no consumer group)`
        : `Subscribed to ${params.topics.join(', ')} (groupId=${params.groupId})`,
    });
    return { ok: true };
  }

  async unsubscribe(connectionId: string): Promise<void> {
    const api = getElectronAPI();
    if (!api) return;
    await api.kafka.unsubscribe({ connectionId });
    this.subscribed.delete(connectionId);
    this.unbindMessageListener(connectionId);
    const store = useKafkaStore.getState();
    store.updateConsumer(connectionId, { status: 'idle' });
    store.addMessage(connectionId, { direction: 'system', topic: '', value: 'Unsubscribed' });
  }

  async disconnect(connectionId: string): Promise<void> {
    const api = getElectronAPI();
    if (!api) return;
    await api.kafka.disconnect({ connectionId });
    this.subscribed.delete(connectionId);
    this.unbindMessageListener(connectionId);
    this.lifecycle.unbind(connectionId);
    const store = useKafkaStore.getState();
    store.updateStatus(connectionId, 'disconnected');
    store.updateConsumer(connectionId, { status: 'idle' });
  }

  // ---- Admin (topic + consumer-group management) -------------------------

  async listTopics(
    connectionId: string
  ): Promise<{ ok: true; topics: string[] } | { ok: false; error: string }> {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.listTopics({ connectionId });
    if (!result.success || !result.topics) {
      return { ok: false, error: result.error ?? 'List topics failed' };
    }
    return { ok: true, topics: result.topics };
  }

  async createTopic(params: {
    connectionId: string;
    topic: string;
    partitions: number;
    replicationFactor: number;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.createTopic(params);
    if (!result.success) return { ok: false, error: result.error ?? 'Create topic failed' };
    return { ok: true };
  }

  async deleteTopic(
    connectionId: string,
    topic: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.deleteTopic({ connectionId, topic });
    if (!result.success) return { ok: false, error: result.error ?? 'Delete topic failed' };
    return { ok: true };
  }

  async listGroups(
    connectionId: string
  ): Promise<{ ok: true; groups: KafkaGroupInfo[] } | { ok: false; error: string }> {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.listGroups({ connectionId });
    if (!result.success || !result.groups) {
      return { ok: false, error: result.error ?? 'List groups failed' };
    }
    return { ok: true, groups: result.groups };
  }

  async inspectTopic(
    connectionId: string,
    topic: string
  ): Promise<
    | { ok: true; partitions: KafkaPartitionWatermark[]; config: KafkaTopicConfigEntry[] }
    | { ok: false; error: string }
  > {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.inspectTopic({ connectionId, topic });
    if (!result.success || !result.partitions || !result.config) {
      return { ok: false, error: result.error ?? 'Inspect topic failed' };
    }
    return { ok: true, partitions: result.partitions, config: result.config };
  }

  async inspectGroup(
    connectionId: string,
    groupId: string
  ): Promise<
    | { ok: true; group: KafkaGroupDescription | null; offsets: KafkaPartitionLag[] }
    | { ok: false; error: string }
  > {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.inspectGroup({ connectionId, groupId });
    if (!result.success || !result.offsets) {
      return { ok: false, error: result.error ?? 'Inspect group failed' };
    }
    return { ok: true, group: result.group ?? null, offsets: result.offsets };
  }

  async resetGroupOffsets(params: KafkaResetGroupOffsetsParams): Promise<
    | {
        ok: true;
        offsets: KafkaOffsetResetRow[];
        skipped: KafkaOffsetResetSkip[];
        dryRun: boolean;
      }
    | { ok: false; error: string }
  > {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.resetGroupOffsets(params);
    if (!result.success) return { ok: false, error: result.error ?? 'Reset offsets failed' };
    return {
      ok: true,
      offsets: result.offsets ?? [],
      skipped: result.skipped ?? [],
      dryRun: result.dryRun ?? false,
    };
  }

  async deleteGroupOffsets(params: KafkaDeleteGroupOffsetsParams): Promise<
    | {
        ok: true;
        deleted: { topic: string; partitions: number[] }[];
        skipped: KafkaOffsetResetSkip[];
      }
    | { ok: false; error: string }
  > {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.deleteGroupOffsets(params);
    if (!result.success) return { ok: false, error: result.error ?? 'Delete offsets failed' };
    return { ok: true, deleted: result.deleted ?? [], skipped: result.skipped ?? [] };
  }

  async deleteGroup(
    connectionId: string,
    groupId: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.deleteGroup({ connectionId, groupId });
    if (!result.success) return { ok: false, error: result.error ?? 'Delete group failed' };
    return { ok: true };
  }

  private bindLifecycleListeners(connectionId: string): void {
    // Rebinding replaces, never stacks, handlers: otherwise every broker event
    // is processed once per prior connection attempt on this id.
    this.lifecycle.bind(connectionId, {
      close: () => {
        this.inbound.flush(connectionId);
        const store = useKafkaStore.getState();
        store.updateStatus(connectionId, 'disconnected');
        store.addMessage(connectionId, {
          direction: 'system',
          topic: '',
          value: 'Connection closed',
        });
      },
      error: (payload) => {
        this.inbound.flush(connectionId);
        const err = payload as { scope?: string; message?: string };
        const msg = err.message ?? 'Kafka error';
        useKafkaStore.getState().addMessage(connectionId, {
          direction: 'system',
          topic: '',
          value: `[${err.scope ?? 'error'}] ${msg}`,
          error: msg,
        });
      },
      consumerClosed: () => {
        this.inbound.flush(connectionId);
        const store = useKafkaStore.getState();
        store.updateConsumer(connectionId, { status: 'idle' });
        store.addMessage(connectionId, {
          direction: 'system',
          topic: '',
          value: 'Consumer closed',
        });
      },
      consumerStatus: (payload) => {
        const status = payload as { state?: string };
        useKafkaStore
          .getState()
          .updateConsumer(connectionId, { groupState: status.state ?? 'unknown' });
      },
      consumerLag: (payload) => {
        const event = payload as { lag?: { topic: string; offsets: string[] }[] };
        if (!event.lag) return;
        const store = useKafkaStore.getState();
        const paused = store.connections[connectionId]?.consumer.pausedPartitions;
        // Lag -1 = no longer assigned to this member: main already dropped its pause.
        const assigned = (key: string) => {
          const sep = key.lastIndexOf(':');
          const topic = event.lag?.find((l) => l.topic === key.slice(0, sep));
          return topic?.offsets[Number(key.slice(sep + 1))] !== '-1';
        };
        store.updateConsumer(connectionId, {
          lag: event.lag,
          ...(paused?.length ? { pausedPartitions: paused.filter(assigned) } : {}),
        });
      },
    });
  }

  private bindMessageListener(connectionId: string): void {
    // Idempotent: a consumer can close main-side (browse stop-after-N, fetch
    // error) without an unsubscribe, so a re-subscribe must not stack listeners.
    this.messages.bind(connectionId, {
      message: (payload) => {
        this.inbound.push(connectionId, toReceivedMessage(payload as KafkaConsumedPayload));
      },
    });
  }

  private unbindMessageListener(connectionId: string): void {
    // Drains buffered records first so the last ~100 ms aren't dropped.
    this.messages.unbind(connectionId);
  }
}

export const kafkaManager = new KafkaManager();
