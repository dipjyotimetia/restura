import {
  ConsumedMessageBuffer,
  type KafkaConsumedPayload,
  toReceivedMessage,
} from '@/features/kafka/lib/consumedMessageBuffer';
import type {
  KafkaAuth,
  KafkaCompression,
  KafkaConnection,
  KafkaRegistry,
} from '@/features/kafka/store/useKafkaStore';
import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { secureStorage } from '@/lib/shared/secure-storage';
import { KAFKA_CHANNEL, kafkaChannel } from '../../../../electron/shared/kafka-channels';
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
  KafkaSchemaRefIpc,
  KafkaTopicConfigEntry,
} from '../../../../electron/types/electron-api';
import { isKafkaBrowse, type KafkaSubscribePayload, toBrowseSubscribe } from './kafkaBrowse';

export type KafkaResetGroupOffsetsParams = Parameters<ElectronKafkaAPI['resetGroupOffsets']>[0];
export type KafkaDeleteGroupOffsetsParams = Parameters<ElectronKafkaAPI['deleteGroupOffsets']>[0];

export type KafkaSecretField =
  | 'sasl-password'
  | 'oauth-token'
  | 'tls-passphrase'
  | 'registry-password'
  | 'registry-token';

export function kafkaSecretKey(connectionId: string, field: KafkaSecretField): string {
  // Every field name matches a secureStorage sensitive-key pattern
  // (`password`/`token`/`passphrase`) so the value routes to electron-store +
  // safeStorage in the desktop build rather than plaintext localStorage.
  return `kafka:${connectionId}:${field}`;
}

function readSecret(connectionId: string, field: KafkaSecretField): Promise<string | null> {
  return secureStorage.getAsync(kafkaSecretKey(connectionId, field));
}

/**
 * Resolve the persisted registry config (secret sentinels) into the plaintext
 * IPC shape. Returns undefined when no registry is configured.
 */
async function resolveRegistry(
  connectionId: string,
  registry: KafkaRegistry | undefined
): Promise<KafkaRegistryIpc | undefined> {
  if (!registry) return undefined;
  const out: KafkaRegistryIpc = { url: registry.url };
  if (registry.authType === 'bearer') {
    // Handles / external refs cross IPC as references and resolve only in main.
    const stored = registry.bearerToken;
    const token =
      stored === KAFKA_SECRET_SENTINEL ? await readSecret(connectionId, 'registry-token') : stored;
    if (!token || (typeof token === 'object' && token.kind === 'inline' && !token.value)) {
      throw new Error('Missing Schema Registry bearer token — re-enter it.');
    }
    out.auth = { type: 'bearer', token };
    return out;
  }
  if (registry.auth) {
    // A sentinel means the real value lives in secureStorage; otherwise it's
    // the inline value (or undefined).
    const resolve = (value: string | undefined, field: KafkaSecretField): Promise<string | null> =>
      value === KAFKA_SECRET_SENTINEL
        ? readSecret(connectionId, field)
        : Promise.resolve(value ?? null);
    // Basic stays in the untyped wire shape (main normalises it to type 'basic').
    const auth: { username?: string; password?: string } = {};
    if (registry.auth.username) auth.username = registry.auth.username;
    const password = await resolve(registry.auth.password, 'registry-password');
    if (password) auth.password = password;
    if (Object.keys(auth).length > 0) out.auth = auth;
  }
  return out;
}

/**
 * Resolve the persisted KafkaAuth (which holds sentinels for secrets and
 * file paths for TLS material) into the wire-format expected by the Electron
 * IPC handler (which expects plaintext + file contents).
 */
async function resolveAuth(connectionId: string, auth: KafkaAuth): Promise<KafkaAuthIpc | null> {
  if (auth.securityProtocol === 'PLAINTEXT') {
    return { securityProtocol: 'PLAINTEXT' };
  }

  // Resolve TLS material once — used by SASL_SSL and SSL.
  let tlsIpc:
    | {
        ca?: string;
        cert?: string;
        key?: string;
        passphrase?: string;
        rejectUnauthorized?: boolean;
      }
    | undefined;
  if (auth.tls) {
    tlsIpc = {};
    if (auth.tls.rejectUnauthorized !== undefined) {
      tlsIpc.rejectUnauthorized = auth.tls.rejectUnauthorized;
    }
    const api = getElectronAPI();
    if (api) {
      const readPath = (p?: string): Promise<{ success: boolean; content?: string } | null> =>
        p ? api.fs.readFile(p) : Promise.resolve(null);
      const [caResult, certResult, keyResult] = await Promise.all([
        readPath(auth.tls.caPath),
        readPath(auth.tls.certPath),
        readPath(auth.tls.keyPath),
      ]);
      if (auth.tls.caPath) {
        if (!caResult?.success || !caResult.content) return null;
        tlsIpc.ca = caResult.content;
      }
      if (auth.tls.certPath) {
        if (!certResult?.success || !certResult.content) return null;
        tlsIpc.cert = certResult.content;
      }
      if (auth.tls.keyPath) {
        if (!keyResult?.success || !keyResult.content) return null;
        tlsIpc.key = keyResult.content;
      }
    }
    if (auth.tls.passphrase === KAFKA_SECRET_SENTINEL) {
      const real = await readSecret(connectionId, 'tls-passphrase');
      if (real) tlsIpc.passphrase = real;
    } else if (auth.tls.passphrase) {
      tlsIpc.passphrase = auth.tls.passphrase;
    }
  }

  if (auth.securityProtocol === 'SSL') {
    return { securityProtocol: 'SSL', tls: tlsIpc ?? {} };
  }

  if (!auth.sasl) return null;
  const sasl: Extract<KafkaAuthIpc, { securityProtocol: 'SASL_PLAINTEXT' }>['sasl'] =
    auth.sasl.mechanism === 'OAUTHBEARER'
      ? {
          mechanism: 'OAUTHBEARER',
          token:
            auth.sasl.token === KAFKA_SECRET_SENTINEL
              ? ((await readSecret(connectionId, 'oauth-token')) ?? '')
              : auth.sasl.token,
          ...(auth.sasl.extensions ? { extensions: auth.sasl.extensions } : {}),
        }
      : {
          mechanism: auth.sasl.mechanism,
          username: auth.sasl.username,
          password:
            auth.sasl.password === KAFKA_SECRET_SENTINEL
              ? ((await readSecret(connectionId, 'sasl-password')) ?? '')
              : auth.sasl.password,
        };
  if (
    (sasl.mechanism === 'OAUTHBEARER' && !sasl.token) ||
    (sasl.mechanism !== 'OAUTHBEARER' && !sasl.password)
  ) {
    return null;
  }

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
  private inbound = new ConsumedMessageBuffer((connectionId, batch) =>
    useKafkaStore.getState().addMessages(connectionId, batch)
  );

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
      const msg = 'Missing SASL password or TLS material — re-enter credentials.';
      store.addMessage(connection.id, { direction: 'system', topic: '', value: msg, error: msg });
      return { ok: false, error: msg };
    }

    // Reconnecting with the same id must replace, not stack, renderer event
    // handlers. Otherwise every broker event is processed once per prior
    // connection attempt.
    this.unbindLifecycleListeners(connection.id);
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
      this.unbindLifecycleListeners(connection.id);
      return { ok: false, error: msg };
    }

    if (!result.success) {
      store.updateStatus(connection.id, 'disconnected');
      const msg = result.error ?? 'Kafka connect failed';
      store.addMessage(connection.id, { direction: 'system', topic: '', value: msg, error: msg });
      this.unbindLifecycleListeners(connection.id);
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
    this.unbindLifecycleListeners(connectionId);
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
    const api = getElectronAPI();
    if (!api?.kafka) return;

    api.kafka.on(kafkaChannel(KAFKA_CHANNEL.CLOSE, connectionId), () => {
      this.inbound.flush(connectionId);
      const store = useKafkaStore.getState();
      store.updateStatus(connectionId, 'disconnected');
      store.addMessage(connectionId, {
        direction: 'system',
        topic: '',
        value: 'Connection closed',
      });
    });

    api.kafka.on(kafkaChannel(KAFKA_CHANNEL.ERROR, connectionId), (payload: unknown) => {
      this.inbound.flush(connectionId);
      const err = payload as { scope?: string; message?: string };
      const msg = err.message ?? 'Kafka error';
      useKafkaStore.getState().addMessage(connectionId, {
        direction: 'system',
        topic: '',
        value: `[${err.scope ?? 'error'}] ${msg}`,
        error: msg,
      });
    });

    api.kafka.on(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, connectionId), () => {
      this.inbound.flush(connectionId);
      const store = useKafkaStore.getState();
      store.updateConsumer(connectionId, { status: 'idle' });
      store.addMessage(connectionId, { direction: 'system', topic: '', value: 'Consumer closed' });
    });
    api.kafka.on(kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, connectionId), (payload: unknown) => {
      const status = payload as { state?: string };
      useKafkaStore
        .getState()
        .updateConsumer(connectionId, { groupState: status.state ?? 'unknown' });
    });
    api.kafka.on(kafkaChannel(KAFKA_CHANNEL.CONSUMER_LAG, connectionId), (payload: unknown) => {
      const event = payload as { lag?: { topic: string; offsets: string[] }[] };
      if (event.lag) useKafkaStore.getState().updateConsumer(connectionId, { lag: event.lag });
    });
  }

  private unbindLifecycleListeners(connectionId: string): void {
    const api = getElectronAPI();
    if (!api?.kafka) return;
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.CLOSE, connectionId));
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.ERROR, connectionId));
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, connectionId));
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.CONNECTED, connectionId));
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, connectionId));
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.CONSUMER_LAG, connectionId));
  }

  private bindMessageListener(connectionId: string): void {
    const api = getElectronAPI();
    if (!api?.kafka) return;
    // Idempotent: a consumer can close main-side (browse stop-after-N, fetch
    // error) without an unsubscribe, so a re-subscribe must not stack listeners.
    this.unbindMessageListener(connectionId);
    api.kafka.on(kafkaChannel(KAFKA_CHANNEL.MESSAGE, connectionId), (payload: unknown) => {
      this.inbound.push(connectionId, toReceivedMessage(payload as KafkaConsumedPayload));
    });
  }

  private unbindMessageListener(connectionId: string): void {
    // Drain buffered records first so the last ~100 ms aren't dropped.
    this.inbound.flush(connectionId);
    const api = getElectronAPI();
    if (!api?.kafka) return;
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.MESSAGE, connectionId));
  }
}

export const kafkaManager = new KafkaManager();
