import { useKafkaStore, KAFKA_SECRET_SENTINEL } from '@/features/kafka/store/useKafkaStore';
import type {
  KafkaAuth,
  KafkaCompression,
  KafkaConnection,
  KafkaMessageDirection,
  KafkaRegistry,
} from '@/features/kafka/store/useKafkaStore';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { secureStorage } from '@/lib/shared/secure-storage';
import { KAFKA_CHANNEL, kafkaChannel } from '../../../../electron/shared/kafka-channels';
import type {
  KafkaAuthIpc,
  KafkaGroupDescription,
  KafkaGroupInfo,
  KafkaPartitionLag,
  KafkaPartitionWatermark,
  KafkaRegistryIpc,
  KafkaTopicConfigEntry,
} from '../../../../electron/types/electron-api';

type KafkaSecretField = 'sasl-password' | 'tls-passphrase' | 'registry-password' | 'registry-token';

export function kafkaSecretKey(connectionId: string, field: KafkaSecretField): string {
  // Hits the sensitive-key regex (`password`/`auth`) in secureStorage so it
  // routes to electron-store + safeStorage in the desktop build.
  return `kafka:${connectionId}:${field}`;
}

function readSecret(connectionId: string, field: KafkaSecretField): string | null {
  return secureStorage.get(kafkaSecretKey(connectionId, field));
}

/**
 * Resolve the persisted registry config (secret sentinels) into the plaintext
 * IPC shape. Returns undefined when no registry is configured.
 */
function resolveRegistry(
  connectionId: string,
  registry: KafkaRegistry | undefined
): KafkaRegistryIpc | undefined {
  if (!registry) return undefined;
  const out: KafkaRegistryIpc = { url: registry.url };
  if (registry.auth) {
    // A sentinel means the real value lives in secureStorage; otherwise it's
    // the inline value (or undefined).
    const resolve = (value: string | undefined, field: KafkaSecretField): string | null =>
      value === KAFKA_SECRET_SENTINEL ? readSecret(connectionId, field) : (value ?? null);
    const auth: NonNullable<KafkaRegistryIpc['auth']> = {};
    if (registry.auth.username) auth.username = registry.auth.username;
    const password = resolve(registry.auth.password, 'registry-password');
    if (password) auth.password = password;
    const token = resolve(registry.auth.token, 'registry-token');
    if (token) auth.token = token;
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
      const real = readSecret(connectionId, 'tls-passphrase');
      if (real) tlsIpc.passphrase = real;
    } else if (auth.tls.passphrase) {
      tlsIpc.passphrase = auth.tls.passphrase;
    }
  }

  if (auth.securityProtocol === 'SSL') {
    return { securityProtocol: 'SSL', tls: tlsIpc ?? {} };
  }

  if (!auth.sasl) return null;
  const saslPassword =
    auth.sasl.password === KAFKA_SECRET_SENTINEL
      ? readSecret(connectionId, 'sasl-password')
      : auth.sasl.password;
  if (!saslPassword) return null;

  const sasl = {
    mechanism: auth.sasl.mechanism,
    username: auth.sasl.username,
    password: saslPassword,
  };

  if (auth.securityProtocol === 'SASL_PLAINTEXT') {
    return { securityProtocol: 'SASL_PLAINTEXT', sasl };
  }
  return { securityProtocol: 'SASL_SSL', sasl, ...(tlsIpc ? { tls: tlsIpc } : {}) };
}

class KafkaManager {
  private subscribed: Set<string> = new Set();

  async connect(connection: KafkaConnection): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) {
      return { ok: false, error: 'Kafka is only available in the Restura desktop app.' };
    }
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useKafkaStore.getState();
    store.updateStatus(connection.id, 'connecting');

    const ipcAuth = await resolveAuth(connection.id, connection.auth);
    if (!ipcAuth) {
      store.updateStatus(connection.id, 'disconnected');
      const msg = 'Missing SASL password or TLS material — re-enter credentials.';
      store.addMessage(connection.id, { direction: 'system', topic: '', value: msg, error: msg });
      return { ok: false, error: msg };
    }

    this.bindLifecycleListeners(connection.id);

    const registry = resolveRegistry(connection.id, connection.registry);
    const result = await api.kafka.connect({
      connectionId: connection.id,
      clientId: connection.clientId,
      bootstrapBrokers: connection.bootstrapBrokers,
      auth: ipcAuth,
      ...(connection.idempotent ? { idempotent: true } : {}),
      ...(registry ? { registry } : {}),
    });

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
    value: string;
    headers?: Record<string, string>;
    partition?: number;
    acks: 0 | 1 | -1;
    compression?: KafkaCompression;
    valueSchemaId?: number;
    keySchemaId?: number;
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
      topic: params.topic,
      ...(params.key !== undefined ? { key: params.key } : {}),
      value: params.value,
      ...(params.headers ? { headers: params.headers } : {}),
      ...(params.partition !== undefined ? { partition: params.partition } : {}),
      acks: params.acks,
      ...(params.compression && params.compression !== 'none'
        ? { compression: params.compression }
        : {}),
      ...(params.valueSchemaId !== undefined ? { valueSchemaId: params.valueSchemaId } : {}),
      ...(params.keySchemaId !== undefined ? { keySchemaId: params.keySchemaId } : {}),
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
      ...(params.key !== undefined ? { key: params.key } : {}),
      value: params.value,
      ...(params.headers ? { headers: params.headers } : {}),
    });
    return { ok: true, ack: result.ack };
  }

  async subscribe(params: {
    connectionId: string;
    groupId: string;
    topics: string[];
    fromBeginning: boolean;
    mode?: 'latest' | 'earliest' | 'manual' | 'timestamp';
    offsets?: Array<{ topic: string; partition: number; offset: string }>;
    timestamp?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isElectron()) return { ok: false, error: 'Kafka is desktop-only.' };
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };

    const store = useKafkaStore.getState();
    // The persisted consumer state only tracks groupId/topics/fromBeginning;
    // mode/offsets are transient subscribe-time inputs, so don't push them there.
    store.updateConsumer(params.connectionId, {
      status: 'subscribing',
      groupId: params.groupId,
      topics: params.topics,
      fromBeginning: params.fromBeginning,
    });
    this.bindMessageListener(params.connectionId);

    const result = await api.kafka.subscribe(params);
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
      value: `Subscribed to ${params.topics.join(', ')} (groupId=${params.groupId})`,
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

  async resetGroupOffsets(params: {
    connectionId: string;
    groupId: string;
    topic: string;
    to: 'earliest' | 'latest' | 'specific';
    partitions?: Array<{ partition: number; offset: string }>;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const api = getElectronAPI();
    if (!api) return { ok: false, error: 'Electron API unavailable.' };
    const result = await api.kafka.resetGroupOffsets(params);
    if (!result.success) return { ok: false, error: result.error ?? 'Reset offsets failed' };
    return { ok: true };
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
      const store = useKafkaStore.getState();
      store.updateStatus(connectionId, 'disconnected');
      store.addMessage(connectionId, {
        direction: 'system',
        topic: '',
        value: 'Connection closed',
      });
    });

    api.kafka.on(kafkaChannel(KAFKA_CHANNEL.ERROR, connectionId), (payload: unknown) => {
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
      const store = useKafkaStore.getState();
      store.updateConsumer(connectionId, { status: 'idle' });
      store.addMessage(connectionId, { direction: 'system', topic: '', value: 'Consumer closed' });
    });
  }

  private unbindLifecycleListeners(connectionId: string): void {
    const api = getElectronAPI();
    if (!api?.kafka) return;
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.CLOSE, connectionId));
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.ERROR, connectionId));
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, connectionId));
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.CONNECTED, connectionId));
  }

  private bindMessageListener(connectionId: string): void {
    const api = getElectronAPI();
    if (!api?.kafka) return;
    api.kafka.on(kafkaChannel(KAFKA_CHANNEL.MESSAGE, connectionId), (payload: unknown) => {
      const msg = payload as {
        topic: string;
        partition: number;
        offset: string;
        key?: string;
        value: string;
        headers?: Record<string, string>;
        timestamp: number;
      };
      useKafkaStore.getState().addMessage(connectionId, {
        direction: 'received' as KafkaMessageDirection,
        topic: msg.topic,
        partition: msg.partition,
        offset: msg.offset,
        ...(msg.key !== undefined ? { key: msg.key } : {}),
        value: msg.value,
        ...(msg.headers ? { headers: msg.headers } : {}),
        timestamp: msg.timestamp,
      });
    });
  }

  private unbindMessageListener(connectionId: string): void {
    const api = getElectronAPI();
    if (!api?.kafka) return;
    api.kafka.removeAllListeners(kafkaChannel(KAFKA_CHANNEL.MESSAGE, connectionId));
  }
}

export const kafkaManager = new KafkaManager();
