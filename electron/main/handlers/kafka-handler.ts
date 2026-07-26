import type * as SchemaRegistryLib from '@kafkajs/confluent-schema-registry';
import type * as KafkaLib from '@platformatic/kafka';
import { createLogger } from '@shared/runtime/logger';
import type { WebContents } from 'electron';
import { ipcMain, webContents } from 'electron';
import type { ZodSchema } from 'zod';
import { IPC } from '../../shared/channels';
import { KAFKA_CHANNEL, kafkaChannel } from '../../shared/kafka-channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  type KafkaConnectConfig,
  KafkaConnectSchema,
  KafkaCreateTopicSchema,
  KafkaDeleteGroupSchema,
  KafkaDeleteTopicSchema,
  KafkaDisconnectSchema,
  KafkaInspectGroupSchema,
  KafkaInspectTopicSchema,
  KafkaListGroupsSchema,
  KafkaListTopicsSchema,
  type KafkaProduceConfig,
  KafkaProduceSchema,
  KafkaResetGroupOffsetsSchema,
  KafkaSubscribeSchema,
  KafkaUnsubscribeSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import type { LogEntry } from '../lifecycle/request-logger';
import { assertKafkaBrokersSafe, assertRegistryUrlSafe } from '../security/kafka-broker-guard';
import {
  computeGroupLag,
  decodeDisplayField,
  decodeWirePayload,
  encodeSchemaField,
  flattenConfigDescriptions,
  flattenGroup,
  topicWatermarks,
} from './kafka-serde';

const log = createLogger('kafka');
type SchemaRegistry = SchemaRegistryLib.SchemaRegistry;
type Admin = KafkaLib.Admin;
type AdminOptions = KafkaLib.AdminOptions;
type Consumer<K, V, HK, HV> = KafkaLib.Consumer<K, V, HK, HV>;
type ConsumerOptions<K, V, HK, HV> = KafkaLib.ConsumerOptions<K, V, HK, HV>;
type Message<K, V, HK, HV> = KafkaLib.Message<K, V, HK, HV>;
type MessagesStream<K, V, HK, HV> = KafkaLib.MessagesStream<K, V, HK, HV>;
type Producer<K, V, HK, HV> = KafkaLib.Producer<K, V, HK, HV>;
type ProducerOptions<K, V, HK, HV> = KafkaLib.ProducerOptions<K, V, HK, HV>;
type TopicWithPartitionAndOffset = KafkaLib.TopicWithPartitionAndOffset;
// Keep the heavy Kafka package lazy so it does not delay window creation.
let _kafka: typeof KafkaLib | undefined;
const getKafka = (): typeof KafkaLib => (_kafka ??= require('@platformatic/kafka'));

/** Test seam for the lazy bare require. */
export function __setKafkaForTests(lib: typeof KafkaLib | undefined): void {
  _kafka = lib;
}
let _schemaRegistryLib: typeof SchemaRegistryLib | undefined;
const getSchemaRegistryLib = (): typeof SchemaRegistryLib =>
  (_schemaRegistryLib ??= require('@kafkajs/confluent-schema-registry'));

const bufferOrStringSerializer = (data: string | Buffer | undefined): Buffer | undefined =>
  data == null ? undefined : Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
const stringFieldSerializer = (data: string | undefined): Buffer | undefined =>
  typeof data === 'string' ? Buffer.from(data, 'utf-8') : undefined;
const rawDeserializer = (data: Buffer): Buffer | undefined =>
  Buffer.isBuffer(data) ? data : undefined;
const stringFieldDeserializer = (data: Buffer): string | undefined =>
  Buffer.isBuffer(data) ? data.toString('utf-8') : undefined;
export const kafkaRateLimiter = createKeyedRateLimiter(120, 60_000);
const MAX_CONCURRENT_KAFKA_CONNECTIONS = 20;
type ProduceKV = string | Buffer;
type AppProducer = Producer<ProduceKV, ProduceKV, string, string>;
type AppConsumer = Consumer<Buffer, Buffer, string, string>;
type AppStream = MessagesStream<Buffer, Buffer, string, string>;
type AppMessage = Message<Buffer, Buffer, string, string>;

interface ActiveKafka {
  producer: AppProducer;
  consumer?: AppConsumer;
  stream?: AppStream;
  clientOptions: KafkaClientOptions;
  connectionId: string;
  webContentsId: number;
  /** Producer-only option; the shared client options also feed Consumer/Admin. */
  idempotent: boolean;
  registry?: SchemaRegistry;
  /** Serializes async decode/emission in arrival order. */
  emitChain: Promise<void>;
  wc?: WebContents;
  createdAt: number;
}

interface KafkaClientOptions {
  clientId: string;
  bootstrapBrokers: string[];
  sasl?: {
    mechanism: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';
    username: string;
    password: string;
  };
  tls?: {
    ca?: string;
    cert?: string;
    key?: string;
    passphrase?: string;
    rejectUnauthorized?: boolean;
  };
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

function buildClientOptions(cfg: KafkaConnectConfig): KafkaClientOptions {
  const opts: KafkaClientOptions = {
    clientId: cfg.clientId,
    bootstrapBrokers: cfg.bootstrapBrokers,
  };

  const useTls = cfg.auth.securityProtocol === 'SSL' || cfg.auth.securityProtocol === 'SASL_SSL';

  if (cfg.auth.securityProtocol !== 'PLAINTEXT' && 'sasl' in cfg.auth && cfg.auth.sasl) {
    opts.sasl = {
      mechanism: cfg.auth.sasl.mechanism,
      username: cfg.auth.sasl.username,
      password: cfg.auth.sasl.password,
    };
  }

  if (useTls) {
    const tls = 'tls' in cfg.auth ? cfg.auth.tls : undefined;
    opts.tls = {};
    if (tls?.ca) opts.tls.ca = tls.ca;
    if (tls?.cert) opts.tls.cert = tls.cert;
    if (tls?.key) opts.tls.key = tls.key;
    if (tls?.passphrase) opts.tls.passphrase = tls.passphrase;
    if (tls?.rejectUnauthorized !== undefined) opts.tls.rejectUnauthorized = tls.rejectUnauthorized;
  }

  return opts;
}

function headersFromMap(map: Map<string, string> | undefined): Record<string, string> {
  if (!map) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of map) {
    out[String(k)] = String(v);
  }
  return out;
}
async function closeConsumerAndStream(entry: ActiveKafka): Promise<void> {
  if (entry.stream) {
    try {
      await Promise.resolve(entry.stream.close());
    } catch {
      /* ignore */
    }
    entry.stream = undefined;
  }
  if (entry.consumer) {
    try {
      await Promise.resolve(entry.consumer.close(true));
    } catch {
      /* ignore */
    }
    entry.consumer = undefined;
  }
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
  try {
    await Promise.resolve(entry.producer.close(true));
  } catch {
    /* ignore */
  }
}

async function emitConsumedMessage(entry: ActiveKafka, msg: AppMessage): Promise<void> {
  const key = msg.key == null ? undefined : await decodeDisplayField(entry.registry, msg.key);
  const value =
    msg.value == null
      ? { value: '', encoding: 'utf8' as const }
      : await decodeDisplayField(entry.registry, msg.value);
  if (activeConnections.get(entry.connectionId, entry.webContentsId) !== entry) return;
  emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.MESSAGE, entry.connectionId), {
    topic: msg.topic,
    partition: msg.partition,
    offset: msg.offset.toString(),
    ...(key ? { key: key.value, keyEncoding: key.encoding } : {}),
    value: value.value,
    valueEncoding: value.encoding,
    headers: headersFromMap(msg.headers as Map<string, string> | undefined),
    timestamp: typeof msg.timestamp === 'bigint' ? Number(msg.timestamp) : Date.now(),
  });
}
function bindStreamListeners(entry: ActiveKafka, stream: AppStream): void {
  stream.on('data', (msg: AppMessage) => {
    // One bad decode must not wedge the ordered emission chain.
    entry.emitChain = entry.emitChain.then(() => emitConsumedMessage(entry, msg)).catch(() => {});
  });

  stream.on('error', (err: Error) => {
    if (activeConnections.get(entry.connectionId, entry.webContentsId) !== entry) return;
    emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.ERROR, entry.connectionId), {
      scope: 'consumer',
      message: err.message,
    });
  });

  stream.on('close', () => {
    if (activeConnections.get(entry.connectionId, entry.webContentsId) !== entry) return;
    emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, entry.connectionId), {});
  });
}

export function registerKafkaHandlerIPC(onComplete?: (entry: LogEntry) => void): void {
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
        url: cfg.bootstrapBrokers.join(','),
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
    try {
      if (claim.ownerEntry) {
        const existing = claim.ownerEntry;
        if (onComplete) {
          onComplete({
            ts: Date.now(),
            method: 'CLOSE',
            url: existing.clientOptions.bootstrapBrokers.join(','),
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
        assertKafkaBrokersSafe(cfg.bootstrapBrokers);
        if (cfg.registry) assertRegistryUrlSafe(cfg.registry.url);
      } catch (err) {
        const msg = errorMessage(err);
        log.warn('connection rejected by transport guard', { connectionId });
        logEntry(400, msg);
        return { success: false, error: msg };
      }

      try {
        const clientOptions = buildClientOptions(cfg);
        const kafka = getKafka();

        // Registry encodes/decodes both fields; IPC accepts HTTP Basic only.
        let registry: SchemaRegistry | undefined;
        if (cfg.registry) {
          const auth = cfg.registry.auth;
          registry = new (getSchemaRegistryLib().SchemaRegistry)({
            host: cfg.registry.url,
            ...(auth?.username
              ? { auth: { username: auth.username, password: auth.password ?? '' } }
              : {}),
          });
        }

        // Registry payloads are encoded here; plain strings are UTF-8 encoded.
        const producerOptions = {
          ...clientOptions,
          serializers: {
            key: bufferOrStringSerializer,
            value: bufferOrStringSerializer,
            headerKey: stringFieldSerializer,
            headerValue: stringFieldSerializer,
          },
          // Idempotent producer dedups retries per-partition. The broker requires
          // acks=all(-1) for it; the produce handler enforces that override.
          ...(cfg.idempotent ? { idempotent: true } : {}),
        } as unknown as ProducerOptions<ProduceKV, ProduceKV, string, string>;
        const producer = new kafka.Producer<ProduceKV, ProduceKV, string, string>(producerOptions);
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
          emitChain: Promise.resolve(),
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
      releaseKafkaClaim(connectionId, claim);
    }
  });

  ipcMain.handle(
    IPC.kafka.produce,
    createValidatedEventHandler(
      IPC.kafka.produce,
      KafkaProduceSchema,
      async (cfg: KafkaProduceConfig, event) => {
        const entry = activeConnections.getForOwner(cfg.connectionId, event.sender.id);
        if (!entry) {
          return { success: false, error: 'Not connected' };
        }
        // Idempotent delivery requires all-ISR acknowledgements.
        const acks = entry.idempotent ? -1 : cfg.acks;

        // Registry fields become Confluent-framed buffers; plain fields stay strings.
        const { registry } = entry;
        if ((cfg.valueSchemaId !== undefined || cfg.keySchemaId !== undefined) && !registry) {
          return {
            success: false,
            error: 'A schema ID requires a Schema Registry on this connection.',
          };
        }
        let messageKey: ProduceKV | undefined;
        let messageValue: ProduceKV;
        if (registry && cfg.valueSchemaId !== undefined) {
          const r = await encodeSchemaField(registry, cfg.valueSchemaId, cfg.value, 'value');
          if ('error' in r) return { success: false, error: r.error };
          messageValue = r.value;
        } else {
          const r = decodeWirePayload(cfg.value, cfg.valueEncoding ?? 'utf8', 'value');
          if ('error' in r) return { success: false, error: r.error };
          messageValue = r.value;
        }
        if (registry && cfg.keySchemaId !== undefined) {
          if (cfg.key === undefined) {
            return { success: false, error: 'A key schema ID requires a message key.' };
          }
          const r = await encodeSchemaField(registry, cfg.keySchemaId, cfg.key, 'key');
          if ('error' in r) return { success: false, error: r.error };
          messageKey = r.value;
        } else if (cfg.key !== undefined) {
          const r = decodeWirePayload(cfg.key, cfg.keyEncoding ?? 'utf8', 'key');
          if ('error' in r) return { success: false, error: r.error };
          messageKey = r.value;
        }
        try {
          const result = await entry.producer.send({
            messages: [
              {
                topic: cfg.topic,
                ...(cfg.key !== undefined ? { key: messageKey } : {}),
                value: messageValue,
                ...(cfg.partition !== undefined ? { partition: cfg.partition } : {}),
                ...(cfg.headers
                  ? {
                      headers: Object.entries(cfg.headers).reduce<Map<string, string>>(
                        (m, [k, v]) => m.set(k, v),
                        new Map()
                      ),
                    }
                  : {}),
              },
            ],
            acks,
            ...(cfg.compression && cfg.compression !== 'none'
              ? { compression: cfg.compression }
              : {}),
          });

          const first = result.offsets?.[0];
          if (!first) {
            return {
              success: true,
              ack: {
                topic: cfg.topic,
                partition: cfg.partition ?? -1,
                offset: '-1',
                timestamp: Date.now(),
              },
            };
          }
          return {
            success: true,
            ack: {
              topic: first.topic,
              partition: first.partition,
              offset: first.offset.toString(),
              timestamp: Date.now(),
            },
          };
        } catch (err) {
          return { success: false, error: errorMessage(err) };
        }
      }
    )
  );

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
        // Keep key/value raw for symmetric registry decoding.
        const consumerOptions = {
          ...entry.clientOptions,
          groupId: cfg.groupId,
          deserializers: {
            key: rawDeserializer,
            value: rawDeserializer,
            headerKey: stringFieldDeserializer,
            headerValue: stringFieldDeserializer,
          },
        } as unknown as ConsumerOptions<Buffer, Buffer, string, string>;
        consumer = new kafka.Consumer<Buffer, Buffer, string, string>(consumerOptions);

        // Explicit offsets, timestamp, mode, then legacy fromBeginning take precedence.
        const M = kafka.MessagesStreamModes;
        let mode: (typeof M)[keyof typeof M];
        let offsets: TopicWithPartitionAndOffset[] | undefined;
        if (cfg.offsets && cfg.offsets.length > 0) {
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
          mode = M.LATEST;
        } else if (cfg.mode === 'earliest') {
          mode = M.EARLIEST;
        } else if (cfg.mode === 'latest') {
          mode = M.LATEST;
        } else {
          mode = cfg.fromBeginning ? M.EARLIEST : M.LATEST;
        }

        const stream = await (consumer.consume({
          topics: cfg.topics,
          mode,
          ...(offsets ? { offsets } : {}),
        }) as Promise<AppStream>);

        if (activeConnections.get(cfg.connectionId, event.sender.id) !== entry || entry.consumer) {
          await closeConsumerQuietly(consumer);
          return { success: false, error: 'Not connected' };
        }
        bindStreamListeners(entry, stream);
        entry.consumer = consumer;
        entry.stream = stream;
        return { success: true };
      } catch (err) {
        if (consumer) await closeConsumerQuietly(consumer);
        return { success: false, error: errorMessage(err) };
      }
    })
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

  // Admin calls reuse guarded connection options and always close their short-lived client.

  adminHandle(IPC.kafka.listTopics, KafkaListTopicsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => ({
      topics: await admin.listTopics(),
    }))
  );

  adminHandle(IPC.kafka.createTopic, KafkaCreateTopicSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      await admin.createTopics({
        topics: [cfg.topic],
        partitions: cfg.partitions,
        replicas: cfg.replicationFactor,
      });
      return {};
    })
  );

  adminHandle(IPC.kafka.deleteTopic, KafkaDeleteTopicSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      await admin.deleteTopics({ topics: [cfg.topic] });
      return {};
    })
  );

  adminHandle(IPC.kafka.listGroups, KafkaListGroupsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const groupsMap = await admin.listGroups();
      const groups = Array.from(groupsMap.values()).map((g) => ({
        id: g.id,
        state: String(g.state),
        groupType: g.groupType,
        protocolType: g.protocolType,
      }));
      return { groups };
    })
  );

  adminHandle(IPC.kafka.inspectTopic, KafkaInspectTopicSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const kafka = getKafka();
      const [indexes, configs] = await Promise.all([
        topicPartitionIndexes(admin, cfg.topic),
        admin.describeConfigs({
          resources: [{ resourceType: kafka.ConfigResourceTypes.TOPIC, resourceName: cfg.topic }],
        }),
      ]);
      let partitions: ReturnType<typeof topicWatermarks> = [];
      if (indexes.length > 0) {
        const T = kafka.ListOffsetTimestamps;
        const [earliest, latest] = await Promise.all([
          admin.listOffsets(listOffsetsRequest(cfg.topic, indexes, T.EARLIEST)),
          admin.listOffsets(listOffsetsRequest(cfg.topic, indexes, T.LATEST)),
        ]);
        partitions = topicWatermarks(earliest[0]?.partitions ?? [], latest[0]?.partitions ?? []);
      }
      return { partitions, config: flattenConfigDescriptions(configs) };
    })
  );

  adminHandle(IPC.kafka.inspectGroup, KafkaInspectGroupSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const kafka = getKafka();
      const [describeMap, committedGroups] = await Promise.all([
        admin.describeGroups({ groups: [cfg.groupId] }),
        admin.listConsumerGroupOffsets({ groups: [{ groupId: cfg.groupId }] }),
      ]);
      const raw = describeMap.get(cfg.groupId);
      const group = raw ? flattenGroup(raw) : null;

      const committed = committedGroups.find((g) => g.groupId === cfg.groupId)?.topics ?? [];
      const T = kafka.ListOffsetTimestamps;
      const latestReq = committed
        .filter((t) => t.partitions.length > 0)
        .map((t) => ({
          name: t.name,
          partitions: t.partitions.map((p) => ({
            partitionIndex: p.partitionIndex,
            timestamp: T.LATEST,
          })),
        }));
      const latest = latestReq.length > 0 ? await admin.listOffsets({ topics: latestReq }) : [];
      return { group, offsets: computeGroupLag(committed, latest) };
    })
  );

  adminHandle(IPC.kafka.resetGroupOffsets, KafkaResetGroupOffsetsSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      const kafka = getKafka();
      let partitionOffsets: { partition: number; offset: bigint }[];
      if (cfg.to === 'specific') {
        partitionOffsets = (cfg.partitions ?? []).map((p) => ({
          partition: p.partition,
          offset: BigInt(p.offset),
        }));
      } else {
        const indexes = await topicPartitionIndexes(admin, cfg.topic);
        if (indexes.length === 0) {
          throw new Error(`Topic "${cfg.topic}" has no partitions or does not exist.`);
        }
        const ts =
          cfg.to === 'earliest'
            ? kafka.ListOffsetTimestamps.EARLIEST
            : kafka.ListOffsetTimestamps.LATEST;
        const listed = await admin.listOffsets(listOffsetsRequest(cfg.topic, indexes, ts));
        partitionOffsets = (listed[0]?.partitions ?? []).map((p) => ({
          partition: p.partitionIndex,
          offset: p.offset,
        }));
      }
      await admin.alterConsumerGroupOffsets({
        groupId: cfg.groupId,
        topics: [{ name: cfg.topic, partitionOffsets }],
      });
      return {};
    })
  );

  adminHandle(IPC.kafka.deleteGroup, KafkaDeleteGroupSchema, (cfg, event) =>
    withAdmin(cfg.connectionId, event.sender.id, async (admin) => {
      await admin.deleteGroups({ groups: [cfg.groupId] });
      return {};
    })
  );
}

function adminHandle<TInput, TOutput>(
  channel: string,
  schema: ZodSchema<TInput>,
  handler: (input: TInput, event: Electron.IpcMainInvokeEvent) => Promise<TOutput> | TOutput
): void {
  ipcMain.handle(
    channel,
    rateLimited(kafkaRateLimiter, createValidatedEventHandler(channel, schema, handler))
  );
}

async function topicPartitionIndexes(admin: Admin, topic: string): Promise<number[]> {
  const meta = await admin.metadata({
    topics: [topic],
    autocreateTopics: false,
    forceUpdate: true,
  });
  const count = meta.topics.get(topic)?.partitionsCount ?? 0;
  return Array.from({ length: count }, (_, i) => i);
}

function listOffsetsRequest(topic: string, indexes: number[], timestamp: bigint) {
  return {
    topics: [
      { name: topic, partitions: indexes.map((partitionIndex) => ({ partitionIndex, timestamp })) },
    ],
  };
}

async function withAdmin<T extends object>(
  connectionId: string,
  webContentsId: number,
  fn: (admin: Admin) => Promise<T>
): Promise<({ success: true } & T) | { success: false; error: string }> {
  const entry = activeConnections.getForOwner(connectionId, webContentsId);
  if (!entry) return { success: false, error: 'Not connected' };
  const admin = newAdmin(entry);
  try {
    return { success: true, ...(await fn(admin)) };
  } catch (err) {
    return { success: false, error: errorMessage(err) };
  } finally {
    await closeAdmin(admin);
  }
}

function newAdmin(entry: ActiveKafka): Admin {
  const kafka = getKafka();
  return new kafka.Admin(entry.clientOptions as AdminOptions);
}

async function closeAdmin(admin: Admin): Promise<void> {
  try {
    await Promise.resolve(admin.close());
  } catch {
    /* ignore — best-effort socket release */
  }
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
