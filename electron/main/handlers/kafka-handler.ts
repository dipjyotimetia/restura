import { randomUUID } from 'node:crypto';
import type * as KafkaLib from '@platformatic/kafka';
import { createLogger } from '@shared/runtime/logger';
import type { WebContents } from 'electron';
import { ipcMain, webContents } from 'electron';
import { IPC } from '../../shared/channels';
import { KAFKA_CHANNEL, type KafkaChannelPrefix, kafkaChannel } from '../../shared/kafka-channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  type KafkaCommitMessageConfig,
  KafkaCommitMessageSchema,
  KafkaConnectSchema,
  KafkaDisconnectSchema,
  KafkaSubscribeSchema,
  KafkaUnsubscribeSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import type { LogEntry } from '../lifecycle/request-logger';
import { getExecutionPolicy } from '../security/execution-policy';
import { assertKafkaBrokersSafe, assertRegistryUrlSafe } from '../security/kafka-broker-guard';
import { registerKafkaAdminHandlers } from './kafka/admin-handlers';
import { registerKafkaConsumerControlHandlers } from './kafka/consumer-control-handlers';
import {
  type ConsumerStreamHooks,
  fallbackModeValue,
  type KafkaConsumerSession,
  subscriptionSession,
} from './kafka/consumer-session';
import {
  browseConsumerOptions,
  onBrowseStreamFinished,
  openBrowseStream,
} from './kafka/browse-consumer';
import { buildClientOptions, type KafkaClientOptions } from './kafka/client-options';
import {
  type AppProducer,
  closeKafkaProducerSessions,
  type KafkaProducerEntry,
  registerKafkaProducerHandlers,
} from './kafka/producer-handlers';
import { createKafkaRegistryClient, type KafkaRegistryClient } from './kafka/registry';
import { registerKafkaRegistryHandlers } from './kafka/registry-handlers';
import { decodeDisplayField, headersFromMap } from './kafka-serde';

const log = createLogger('kafka');
type Consumer<K, V, HK, HV> = KafkaLib.Consumer<K, V, HK, HV>;
type ConsumerOptions<K, V, HK, HV> = KafkaLib.ConsumerOptions<K, V, HK, HV>;
type Message<K, V, HK, HV> = KafkaLib.Message<K, V, HK, HV>;
type MessagesStream<K, V, HK, HV> = KafkaLib.MessagesStream<K, V, HK, HV>;
type ProducerOptions<K, V, HK, HV> = KafkaLib.ProducerOptions<K, V, HK, HV>;
type TopicWithPartitionAndOffset = KafkaLib.TopicWithPartitionAndOffset;
// Keep the heavy Kafka package lazy so it does not delay window creation.
let _kafka: typeof KafkaLib | undefined;
const getKafka = (): typeof KafkaLib => (_kafka ??= require('@platformatic/kafka'));

/** Test seam for the lazy bare require. */
export function __setKafkaForTests(lib: typeof KafkaLib | undefined): void {
  _kafka = lib;
}

const rawSerializer = (data: Buffer | undefined): Buffer | undefined => data;
const rawDeserializer = (data: Buffer): Buffer | undefined =>
  Buffer.isBuffer(data) ? data : undefined;
export const kafkaRateLimiter = createKeyedRateLimiter(120, 60_000);
const MAX_CONCURRENT_KAFKA_CONNECTIONS = 20;
type AppConsumer = Consumer<Buffer, Buffer, Buffer, Buffer>;
type AppStream = MessagesStream<Buffer, Buffer, Buffer, Buffer>;
type AppMessage = Message<Buffer, Buffer, Buffer, Buffer>;

interface ActiveKafka extends KafkaProducerEntry {
  consumer?: AppConsumer;
  stream?: AppStream;
  clientOptions: KafkaClientOptions;
  connectionId: string;
  webContentsId: number;
  /** Producer-only option; the shared client options also feed Consumer/Admin. */
  idempotent: boolean;
  transactionalId?: string;
  /** Serializes async decode/emission in arrival order. */
  emitChain: Promise<void>;
  /** Flow control, partition pauses and repositioning for the active consumer stream. */
  session?: KafkaConsumerSession;
  pendingCommits: Map<string, AppMessage>;
  manualCommit: boolean;
  wc?: WebContents;
  createdAt: number;
}

// Awaited teardown stays in this handler; registry disposal covers renderer death.
const activeConnections = new StreamRegistry<ActiveKafka>({
  dispose: (e) => {
    void closeConnection(e);
  },
});

interface PendingKafkaClaim {
  webContentsId: number;
  token: symbol;
  ownerEntry?: ActiveKafka;
  pendingProducer?: AppProducer;
}
const pendingConnections = new Map<string, PendingKafkaClaim>();

async function closeProducerQuietly(producer: AppProducer): Promise<void> {
  try {
    await Promise.resolve(producer.close(true));
  } catch {
    /* ignore */
  }
}

function disposePendingKafkaClaim(claim: PendingKafkaClaim): void {
  if (!claim.pendingProducer) return;
  void closeProducerQuietly(claim.pendingProducer);
  claim.pendingProducer = undefined;
}

function reserveKafkaClaim(
  connectionId: string,
  sender: WebContents
): PendingKafkaClaim | undefined {
  const key = ownerScopedKey(connectionId, sender.id);
  if (pendingConnections.has(key)) return undefined;
  const ownerEntry = activeConnections.getForOwner(connectionId, sender.id);
  const claim: PendingKafkaClaim = {
    webContentsId: sender.id,
    token: Symbol(connectionId),
    ownerEntry,
  };
  pendingConnections.set(key, claim);
  bindRendererCleanup(pendingConnections, sender, (deadId) =>
    disposeByOwner(pendingConnections, deadId, disposePendingKafkaClaim)
  );
  return pendingConnections.get(key) === claim ? claim : undefined;
}

function releaseKafkaClaim(connectionId: string, claim: PendingKafkaClaim): void {
  const key = ownerScopedKey(connectionId, claim.webContentsId);
  if (pendingConnections.get(key)?.token === claim.token) {
    pendingConnections.delete(key);
  }
}

function emitToEntry(entry: ActiveKafka, channel: string, ...args: unknown[]): void {
  // Prefer the cached renderer for high-throughput message delivery.
  if (entry.wc && !entry.wc.isDestroyed()) {
    entry.wc.send(channel, ...args);
    return;
  }
  emitTo(entry.webContentsId, channel, ...args);
}

async function closeConsumerAndStream(entry: ActiveKafka): Promise<void> {
  await entry.session?.close(); // final commit of delivered positions
  if (entry.stream) {
    try {
      await Promise.resolve(entry.stream.close());
    } catch {
      /* ignore */
    }
    entry.stream = undefined;
    entry.session = undefined;
  }
  if (entry.consumer) {
    try {
      await Promise.resolve(entry.consumer.close(true));
    } catch {
      /* ignore */
    }
    entry.consumer = undefined;
  }
  entry.pendingCommits.clear();
}

// Releases consumers that fail before being attached to an active entry.
async function closeConsumerQuietly(consumer: AppConsumer): Promise<void> {
  try {
    await Promise.resolve(consumer.close(true));
  } catch {
    /* ignore — best-effort socket release */
  }
}

async function closeConnection(entry: ActiveKafka): Promise<void> {
  await closeConsumerAndStream(entry);
  await closeKafkaProducerSessions(entry);
  try {
    await Promise.resolve(entry.producer.close(true));
  } catch {
    /* ignore */
  }
  entry.registry?.close();
}

async function emitConsumedMessage(
  entry: ActiveKafka,
  msg: AppMessage,
  signal?: AbortSignal
): Promise<void> {
  const key = msg.key == null ? undefined : await decodeDisplayField(entry.registry, msg.key);
  const value =
    msg.value == null
      ? { value: '', encoding: 'utf8' as const }
      : await decodeDisplayField(entry.registry, msg.value);
  if (signal?.aborted || activeConnections.get(entry.connectionId, entry.webContentsId) !== entry)
    return;
  let commitToken: string | undefined;
  if (entry.manualCommit) {
    commitToken = randomUUID();
    entry.pendingCommits.set(commitToken, msg);
    while (entry.pendingCommits.size > 1000) {
      const oldest = entry.pendingCommits.keys().next().value;
      if (oldest) entry.pendingCommits.delete(oldest);
      else break;
    }
  }
  emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.MESSAGE, entry.connectionId), {
    topic: msg.topic,
    partition: msg.partition,
    offset: msg.offset.toString(),
    ...(key ? { key: key.value, keyEncoding: key.encoding } : {}),
    ...(key?.schema ? { keySchema: key.schema } : {}),
    value: value.value,
    valueEncoding: value.encoding,
    ...(value.schema ? { valueSchema: value.schema } : {}),
    ...(msg.value == null ? { tombstone: true } : {}),
    headers: headersFromMap(msg.headers),
    binaryHeaders: Array.from(msg.headers ?? [], ([headerKey, headerValue]) => ({
      key: headerKey.toString('base64'),
      value: headerValue.toString('base64'),
    })),
    timestamp: typeof msg.timestamp === 'bigint' ? Number(msg.timestamp) : Date.now(),
    ...(commitToken ? { commitToken } : {}),
  });
}
function consumerStreamHooks(entry: ActiveKafka): ConsumerStreamHooks {
  const isCurrent = () => activeConnections.get(entry.connectionId, entry.webContentsId) === entry;
  const emit = (prefix: KafkaChannelPrefix, payload: unknown): void => {
    if (isCurrent()) emitToEntry(entry, kafkaChannel(prefix, entry.connectionId), payload);
  };
  return {
    deliver: (msg, signal) => emitConsumedMessage(entry, msg, signal),
    onError: (err) => emit(KAFKA_CHANNEL.ERROR, { scope: 'consumer', message: err.message }),
    onClose: () => emit(KAFKA_CHANNEL.CONSUMER_CLOSED, {}),
  };
}

export function registerKafkaHandlerIPC(onComplete?: (entry: LogEntry) => void): void {
  registerKafkaProducerHandlers((connectionId, ownerId) =>
    activeConnections.getForOwner(connectionId, ownerId)
  );
  ipcMain.handle(IPC.kafka.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.kafka.connect, event);
    const cfg = validateIpcInput(KafkaConnectSchema, rawConfig, IPC.kafka.connect);
    const { connectionId } = cfg;
    const webContentsId = event.sender.id;
    const startTime = Date.now();
    // Connection metadata only; message bodies are never logged.
    const logEntry = (status: number, error?: string): void => {
      if (!onComplete) return;
      onComplete({
        ts: startTime,
        method: 'CONNECT',
        url: `kafka://connection/${encodeURIComponent(connectionId)}`,
        status,
        durationMs: Date.now() - startTime,
        protocol: 'kafka',
        requestId: connectionId,
        ...(error !== undefined ? { error } : {}),
      });
    };

    if (!kafkaRateLimiter.check(webContentsId)) {
      logEntry(429, 'Rate limit exceeded');
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    if (activeConnections.size() + pendingConnections.size >= MAX_CONCURRENT_KAFKA_CONNECTIONS) {
      logEntry(503, 'Too many open connections');
      return { success: false, error: 'Too many open Kafka connections.' };
    }

    // Reserve this renderer's id; other renderers may independently use the same external id.
    const claim = reserveKafkaClaim(connectionId, event.sender);
    if (!claim) return { success: false, error: 'Not connected' };
    const key = ownerScopedKey(connectionId, webContentsId);
    let registry: KafkaRegistryClient | undefined; // closed in finally unless an entry owns it
    try {
      if (claim.ownerEntry) {
        const existing = claim.ownerEntry;
        if (onComplete) {
          onComplete({
            ts: Date.now(),
            method: 'CLOSE',
            url: `kafka://connection/${encodeURIComponent(connectionId)}`,
            status: 0,
            durationMs: Date.now() - existing.createdAt,
            protocol: 'kafka',
            requestId: connectionId,
          });
        }
        await closeConnection(existing);
        if (
          pendingConnections.get(key)?.token !== claim.token ||
          activeConnections.get(connectionId, webContentsId) !== existing
        ) {
          return { success: false, error: 'Not connected' };
        }
        activeConnections.remove(connectionId, webContentsId);
      }

      try {
        assertKafkaBrokersSafe(cfg.bootstrapBrokers, getExecutionPolicy().security);
        if (cfg.registry) assertRegistryUrlSafe(cfg.registry.url, getExecutionPolicy().security);
      } catch (err) {
        const msg = errorMessage(err);
        log.warn('connection rejected by transport guard', { connectionId });
        logEntry(400, msg);
        return { success: false, error: msg };
      }

      try {
        const clientOptions = buildClientOptions(cfg);
        const kafka = getKafka();

        // Registry encodes/decodes both fields over a TLS-policy, SSRF-guarded agent.
        const security = getExecutionPolicy().security;
        registry = cfg.registry && (await createKafkaRegistryClient(cfg.registry, security));

        // Registry payloads are encoded here; plain strings are UTF-8 encoded.
        const producerOptions = {
          ...clientOptions,
          serializers: {
            key: rawSerializer,
            value: rawSerializer,
            headerKey: rawSerializer,
            headerValue: rawSerializer,
          },
          // Idempotent producer dedups retries per-partition. The broker requires
          // acks=all(-1) for it; the produce handler enforces that override.
          ...(cfg.idempotent ? { idempotent: true } : {}),
          ...(cfg.transactionalId ? { transactionalId: cfg.transactionalId } : {}),
        } as ProducerOptions<Buffer, Buffer, Buffer, Buffer>;
        const producer = new kafka.Producer<Buffer, Buffer, Buffer, Buffer>(producerOptions);
        claim.pendingProducer = producer;

        // Probe metadata before reporting connected; this stays read-only.
        await producer.metadata({ autocreateTopics: false, forceUpdate: true });
        if (pendingConnections.get(key)?.token !== claim.token) {
          if (claim.pendingProducer === producer) {
            claim.pendingProducer = undefined;
            await closeProducerQuietly(producer);
          }
          return { success: false, error: 'Not connected' };
        }

        const wc = webContents.fromId(webContentsId) ?? undefined;
        const entry: ActiveKafka = {
          producer,
          clientOptions,
          connectionId,
          webContentsId,
          idempotent: cfg.idempotent ?? false,
          ...(cfg.transactionalId ? { transactionalId: cfg.transactionalId } : {}),
          emitChain: Promise.resolve(),
          pendingCommits: new Map(),
          manualCommit: false,
          ...(registry ? { registry } : {}),
          ...(wc ? { wc } : {}),
          createdAt: Date.now(),
        };
        const claimed = activeConnections.tryAdd(connectionId, event.sender, entry);
        if (!claimed) {
          claim.pendingProducer = undefined;
          await closeProducerQuietly(producer);
          return { success: false, error: 'Not connected' };
        }
        claim.pendingProducer = undefined;
        registry = undefined;

        emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONNECTED, connectionId), {
          timestamp: Date.now(),
        });
        log.info('connected', {
          connectionId,
          idempotent: entry.idempotent,
          schemaRegistry: Boolean(entry.registry),
        });
        logEntry(0);
        return { success: true };
      } catch (err) {
        if (claim.pendingProducer) {
          const producer = claim.pendingProducer;
          claim.pendingProducer = undefined;
          await closeProducerQuietly(producer);
        }
        const msg = errorMessage(err);
        log.warn('connect failed', { connectionId });
        logEntry(500, msg);
        return { success: false, error: msg };
      }
    } finally {
      registry?.close();
      releaseKafkaClaim(connectionId, claim);
    }
  });

  ipcMain.handle(
    IPC.kafka.subscribe,
    createValidatedEventHandler(IPC.kafka.subscribe, KafkaSubscribeSchema, async (cfg, event) => {
      const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
      if (!entry) {
        return { success: false, error: 'Not connected' };
      }
      if (entry.consumer) {
        return { success: false, error: 'Already subscribed — unsubscribe first' };
      }
      // Hoisted so failures before attachment can still close the consumer.
      let consumer: AppConsumer | undefined;
      try {
        const kafka = getKafka();
        if (cfg.membership === 'browse') {
          // Group-less assign + fetch loop: no group join/creation, no commits.
          consumer = new kafka.Consumer(browseConsumerOptions(entry.clientOptions, cfg));
          const stream = await openBrowseStream(consumer, cfg);
          if (
            activeConnections.get(cfg.connectionId, event.sender.id) !== entry ||
            entry.consumer
          ) {
            stream.destroy();
            await closeConsumerQuietly(consumer);
            return { success: false, error: 'Not connected' };
          }
          bindStreamListeners(entry, stream as unknown as AppStream);
          Object.assign(entry, { consumer, stream, manualCommit: false });
          // Stop-after-N or a failure frees the slot once queued records are forwarded.
          onBrowseStreamFinished(stream, () => {
            void entry.emitChain.then(() =>
              entry.stream === (stream as unknown) ? closeConsumerAndStream(entry) : undefined
            );
          });
          return { success: true };
        }
        // Keep key/value raw for symmetric registry decoding.
        const consumerOptions = {
          ...entry.clientOptions,
          groupId: cfg.groupId,
          groupProtocol:
            cfg.groupProtocol === 'consumer'
              ? kafka.GroupProtocols.CONSUMER
              : kafka.GroupProtocols.CLASSIC,
          ...(cfg.groupInstanceId ? { groupInstanceId: cfg.groupInstanceId } : {}),
          ...(cfg.groupProtocol === 'consumer' && cfg.groupRemoteAssignor
            ? { groupRemoteAssignor: cfg.groupRemoteAssignor }
            : {}),
          ...(cfg.sessionTimeoutMs ? { sessionTimeout: cfg.sessionTimeoutMs } : {}),
          ...(cfg.rebalanceTimeoutMs ? { rebalanceTimeout: cfg.rebalanceTimeoutMs } : {}),
          ...(cfg.groupProtocol !== 'consumer' && cfg.heartbeatIntervalMs
            ? { heartbeatInterval: cfg.heartbeatIntervalMs }
            : {}),
          // The session commits *delivered* positions itself (never withheld records).
          autocommit: false,
          isolationLevel: cfg.isolation === 'read-committed' ? 1 : 0,
          ...(cfg.minBytes !== undefined ? { minBytes: cfg.minBytes } : {}),
          ...(cfg.maxBytes !== undefined ? { maxBytes: cfg.maxBytes } : {}),
          ...(cfg.maxBytesPerPartition !== undefined
            ? { maxBytesPerPartition: cfg.maxBytesPerPartition }
            : {}),
          ...(cfg.maxWaitTimeMs !== undefined ? { maxWaitTime: cfg.maxWaitTimeMs } : {}),
          ...(cfg.highWaterMark !== undefined ? { highWaterMark: cfg.highWaterMark } : {}),
          deserializers: {
            key: rawDeserializer,
            value: rawDeserializer,
            headerKey: rawDeserializer,
            headerValue: rawDeserializer,
          },
        } as unknown as ConsumerOptions<Buffer, Buffer, Buffer, Buffer>;
        consumer = new kafka.Consumer<Buffer, Buffer, Buffer, Buffer>(consumerOptions);

        // Explicit offsets, timestamp, mode, then legacy fromBeginning take precedence.
        const M = kafka.MessagesStreamModes;
        let mode: (typeof M)[keyof typeof M];
        let offsets: TopicWithPartitionAndOffset[] | undefined;
        if (cfg.mode === 'manual' && cfg.offsets && cfg.offsets.length > 0) {
          mode = M.MANUAL;
          offsets = cfg.offsets.map((o) => ({
            topic: o.topic,
            partition: o.partition,
            offset: BigInt(o.offset),
          }));
        } else if (cfg.mode === 'timestamp') {
          if (!cfg.timestamp) {
            await closeConsumerQuietly(consumer);
            return { success: false, error: 'A timestamp is required for timestamp mode' };
          }
          // Resolve the first available offset at/after the timestamp per partition.
          const resolved = await consumer.listOffsetsWithTimestamps({
            topics: cfg.topics,
            timestamp: BigInt(cfg.timestamp),
          });
          offsets = [];
          for (const [topic, partitions] of resolved) {
            for (const [partition, { offset }] of partitions) {
              if (offset >= 0n) offsets.push({ topic, partition, offset });
            }
          }
          if (offsets.length === 0) {
            await closeConsumerQuietly(consumer);
            return {
              success: false,
              error: 'No messages at or after that timestamp on the subscribed topic(s).',
            };
          }
          mode = M.MANUAL;
        } else if (cfg.mode === 'manual') {
          mode = M.MANUAL;
        } else if (cfg.mode === 'committed') {
          mode = M.COMMITTED;
        } else if (cfg.mode === 'earliest') {
          mode = M.EARLIEST;
        } else if (cfg.mode === 'latest') {
          mode = M.LATEST;
        } else mode = M.COMMITTED;

        const fallbackMode = fallbackModeValue(kafka, cfg.fallbackMode);
        const stream = await (consumer.consume({
          topics: cfg.topics,
          mode,
          ...(fallbackMode ? { fallbackMode } : {}),
          ...(offsets ? { offsets } : {}),
        }) as Promise<AppStream>);

        if (activeConnections.get(cfg.connectionId, event.sender.id) !== entry || entry.consumer) {
          await closeConsumerQuietly(consumer);
          return { success: false, error: 'Not connected' };
        }
        entry.consumer = consumer;
        entry.session = subscriptionSession(cfg, kafka, consumerStreamHooks(entry));
        entry.session.bind(entry, stream);
        entry.manualCommit = cfg.commitPolicy === 'manual';
        consumer.on('consumer:group:join', (payload) => {
          emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, entry.connectionId), {
            state: 'joined',
            ...payload,
          });
        });
        consumer.on('consumer:group:rebalance', (payload) => {
          emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, entry.connectionId), {
            state: 'rebalancing',
            ...payload,
          });
        });
        consumer.on('consumer:group:leave', (payload) => {
          emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, entry.connectionId), {
            state: 'left',
            ...payload,
          });
        });
        consumer.on('consumer:lag', (lag) => {
          emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONSUMER_LAG, entry.connectionId), {
            lag: Array.from(lag, ([topic, offsets]) => ({
              topic,
              offsets: offsets.map(String),
            })),
          });
        });
        if (cfg.lagIntervalMs) {
          consumer.startLagMonitoring({ topics: cfg.topics }, cfg.lagIntervalMs);
        }
        return { success: true };
      } catch (err) {
        if (consumer) await closeConsumerQuietly(consumer);
        return { success: false, error: errorMessage(err) };
      }
    })
  );

  registerKafkaConsumerControlHandlers({
    getEntry: (connectionId, ownerId) => activeConnections.getForOwner(connectionId, ownerId),
    getKafka,
    rateLimiter: kafkaRateLimiter,
    emitStatus: (entry, payload) =>
      emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, entry.connectionId), payload),
  });

  ipcMain.handle(
    IPC.kafka.commitMessage,
    createValidatedEventHandler(
      IPC.kafka.commitMessage,
      KafkaCommitMessageSchema,
      async (cfg: KafkaCommitMessageConfig, event) => {
        const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
        if (!entry?.consumer) return { success: false, error: 'No consumer is active.' };
        const message = entry.pendingCommits.get(cfg.commitToken);
        if (!message) return { success: false, error: 'Commit token is unknown or expired.' };
        try {
          await Promise.resolve(message.commit());
          entry.pendingCommits.delete(cfg.commitToken);
          return { success: true };
        } catch (err) {
          return { success: false, error: errorMessage(err) };
        }
      }
    )
  );

  ipcMain.handle(
    IPC.kafka.unsubscribe,
    createValidatedEventHandler(
      IPC.kafka.unsubscribe,
      KafkaUnsubscribeSchema,
      async (cfg, event) => {
        const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        await closeConsumerAndStream(entry);
        return { success: true };
      }
    )
  );

  ipcMain.handle(
    IPC.kafka.disconnect,
    createValidatedEventHandler(IPC.kafka.disconnect, KafkaDisconnectSchema, async (cfg, event) => {
      const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
      if (entry) {
        await closeConnection(entry);
        if (activeConnections.get(cfg.connectionId, entry.webContentsId) === entry) {
          activeConnections.remove(cfg.connectionId, entry.webContentsId);
          emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CLOSE, cfg.connectionId), {});
        }
      }
      return { success: true };
    })
  );

  const getEntry = (connectionId: string, ownerId: number) =>
    activeConnections.getForOwner(connectionId, ownerId);
  registerKafkaAdminHandlers({ getEntry, getKafka, rateLimiter: kafkaRateLimiter });
  registerKafkaRegistryHandlers({ getEntry, rateLimiter: kafkaRateLimiter });
}

export async function stopKafkaCleanup(): Promise<void> {
  const pending = Array.from(pendingConnections.values());
  pendingConnections.clear();
  for (const claim of pending) {
    if (!claim.pendingProducer) continue;
    const producer = claim.pendingProducer;
    claim.pendingProducer = undefined;
    await closeProducerQuietly(producer);
  }
  for (const entry of activeConnections.values()) {
    await closeConnection(entry);
  }
  activeConnections.clear();
}
