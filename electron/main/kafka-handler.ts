import { ipcMain, webContents } from 'electron';
import type { WebContents } from 'electron';
import type {
  Admin,
  AdminOptions,
  Consumer,
  ConsumerOptions,
  Message,
  MessagesStream,
  Producer,
  ProducerOptions,
  TopicWithPartitionAndOffset,
} from '@platformatic/kafka';
import type { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import { createKeyedRateLimiter } from './ipc-rate-limiter';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { emitTo, errorMessage } from './ipc-utils';
import { KAFKA_CHANNEL, kafkaChannel } from '../shared/kafka-channels';
import { IPC } from '../shared/channels';
import { assertKafkaBrokersSafe, assertRegistryUrlSafe } from './kafka-broker-guard';
import { encodeSchemaField, decodeField } from './kafka-serde';
import type { LogEntry } from './request-logger';
import {
  KafkaConnectSchema,
  KafkaProduceSchema,
  KafkaSubscribeSchema,
  KafkaUnsubscribeSchema,
  KafkaDisconnectSchema,
  KafkaListTopicsSchema,
  KafkaCreateTopicSchema,
  KafkaDeleteTopicSchema,
  KafkaListGroupsSchema,
  validateIpcInput,
  createValidatedHandler,
  assertTrustedSender,
  type KafkaConnectConfig,
  type KafkaProduceConfig,
} from './ipc-validators';

// @platformatic/kafka is heavy to evaluate and most sessions never open a Kafka
// connection. Load it lazily on first use rather than at module load (which ran
// before app.whenReady via main.ts, delaying window creation). The named types
// imported above are erased at compile time, so importing them type-only costs
// nothing.
let _kafka: typeof import('@platformatic/kafka') | undefined;
const getKafka = (): typeof import('@platformatic/kafka') =>
  (_kafka ??= require('@platformatic/kafka'));

// Confluent Schema Registry client (key + value encode/decode). Also lazy — only
// constructed when a connection configures a registry URL.
let _schemaRegistryLib: typeof import('@kafkajs/confluent-schema-registry') | undefined;
const getSchemaRegistryLib = (): typeof import('@kafkajs/confluent-schema-registry') =>
  (_schemaRegistryLib ??= require('@kafkajs/confluent-schema-registry'));

// Producer serializers accept either a Buffer (already registry-encoded) or a
// string (plain — utf8-encoded here); consumer deserializers hand back the raw
// Buffer so the handler can decode via the registry off the wire framing.
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

// Produce accepts string (plain) or Buffer (registry-encoded); consume yields raw
// Buffers that the handler decodes via the registry (or reads as UTF-8).
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
  /**
   * Idempotent producer flag. Stored separately from `clientOptions` because
   * `idempotent` is a producer-only option — `clientOptions` is also spread
   * into the Consumer and Admin clients, which don't accept it. When set, the
   * produce path forces acks=-1 (idempotent delivery requires all-ISR acks).
   */
  idempotent: boolean;
  /**
   * Confluent Schema Registry client, built at connect when a registry URL is
   * configured. Encodes the key/value on produce (by schema id) and decodes them
   * on consume (key + value symmetrically, off the Confluent wire framing).
   */
  registry?: SchemaRegistry;
  /**
   * Serializes consumed-message emits. Decode is async (registry HTTP/CPU) but
   * `stream.on('data')` is sync, so we chain emits through this promise to
   * preserve message order.
   */
  emitChain: Promise<void>;
  /** Cached at connect — avoids a `webContents.fromId()` lookup per message. */
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

const activeConnections = new Map<string, ActiveKafka>();

function emitToEntry(entry: ActiveKafka, channel: string, ...args: unknown[]): void {
  // Prefer the cached WebContents (faster than `webContents.fromId` per call);
  // fall back to the shared util when the cache is missing or destroyed.
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

async function closeConnection(entry: ActiveKafka): Promise<void> {
  await closeConsumerAndStream(entry);
  try {
    await Promise.resolve(entry.producer.close(true));
  } catch {
    /* ignore */
  }
}

async function emitConsumedMessage(entry: ActiveKafka, msg: AppMessage): Promise<void> {
  const key = msg.key == null ? undefined : await decodeField(entry.registry, msg.key);
  const value = msg.value == null ? '' : await decodeField(entry.registry, msg.value);
  emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.MESSAGE, entry.connectionId), {
    topic: msg.topic,
    partition: msg.partition,
    offset: msg.offset.toString(),
    key,
    value,
    headers: headersFromMap(msg.headers as Map<string, string> | undefined),
    timestamp: typeof msg.timestamp === 'bigint' ? Number(msg.timestamp) : Date.now(),
  });
}

function bindStreamListeners(entry: ActiveKafka, stream: AppStream): void {
  stream.on('data', (msg: AppMessage) => {
    // Chain so async decodes emit in arrival order; swallow per-message failures
    // so one bad message can't wedge the chain.
    entry.emitChain = entry.emitChain.then(() => emitConsumedMessage(entry, msg)).catch(() => {});
  });

  stream.on('error', (err: Error) => {
    emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.ERROR, entry.connectionId), {
      scope: 'consumer',
      message: err.message,
    });
  });

  stream.on('close', () => {
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
    // Log entries record the connect attempt only — metadata, not message
    // bodies. Per-message logging is intentionally omitted to keep the .jsonl
    // size bounded for high-throughput Kafka topics.
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

    if (activeConnections.size >= MAX_CONCURRENT_KAFKA_CONNECTIONS) {
      logEntry(503, 'Too many open connections');
      return { success: false, error: 'Too many open Kafka connections.' };
    }

    const existing = activeConnections.get(connectionId);
    if (existing) {
      // Renderer reconnected with the same connectionId — tear down the old
      // pair before opening a new one. Emit a CLOSE log entry so the audit
      // trail records the implicit disconnect; matches the explicit
      // kafka:disconnect path.
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
      activeConnections.delete(connectionId);
    }

    try {
      assertKafkaBrokersSafe(cfg.bootstrapBrokers);
      if (cfg.registry) assertRegistryUrlSafe(cfg.registry.url);
    } catch (err) {
      const msg = errorMessage(err);
      logEntry(400, msg);
      return { success: false, error: msg };
    }

    try {
      const clientOptions = buildClientOptions(cfg);
      const kafka = getKafka();

      // Schema Registry (optional): encodes on produce, decodes on consume — for
      // BOTH key and value. Construction is cheap; schemas are fetched on demand.
      // Auth is HTTP Basic (username/password); bearer tokens aren't supported by
      // the registry client — warn rather than silently send unauthenticated.
      let registry: SchemaRegistry | undefined;
      if (cfg.registry) {
        const auth = cfg.registry.auth;
        if (auth?.token && !auth.username) {
          console.warn(
            '[kafka] Schema Registry bearer-token auth is not supported by the registry client; connecting without auth.'
          );
        }
        registry = new (getSchemaRegistryLib().SchemaRegistry)({
          host: cfg.registry.url,
          ...(auth?.username
            ? { auth: { username: auth.username, password: auth.password ?? '' } }
            : {}),
        });
      }

      // The platformatic Producer transports raw bytes; registry encode/decode is
      // done in this handler, so the producer always uses our Buffer-or-string
      // serializers (a Buffer passes through, a plain string is utf8-encoded).
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

      // @platformatic/kafka producers connect lazily; auth/TLS/host errors
      // surface on the first send rather than here. Metadata pre-fetch was
      // tried but some brokers reject `metadata({ topics: [] })`.
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
      activeConnections.set(connectionId, entry);

      // Tear the connection down if the renderer dies without disconnecting.
      // Otherwise the producer/consumer keep their broker sockets open until
      // the Electron process exits — a real leak under hot-reload. Shared
      // helper dedupes the destroyed-listener across reconnects and centralises
      // the owner→dispose walk used by every streaming handler (ADR-0006).
      bindRendererCleanup(activeConnections, event.sender, (deadId) => {
        disposeByOwner(activeConnections, deadId, (e) => {
          void closeConnection(e);
        });
      });

      emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONNECTED, connectionId), {
        timestamp: Date.now(),
      });
      logEntry(0);
      return { success: true };
    } catch (err) {
      const msg = errorMessage(err);
      logEntry(500, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(
    IPC.kafka.produce,
    createValidatedHandler(
      IPC.kafka.produce,
      KafkaProduceSchema,
      async (cfg: KafkaProduceConfig) => {
        const entry = activeConnections.get(cfg.connectionId);
        if (!entry) {
          return { success: false, error: 'Not connected' };
        }
        // An idempotent producer requires acks=all(-1) at the broker. Force it
        // regardless of the per-send `acks` so the send always succeeds (the UI
        // also locks the acks picker to -1 when idempotent is on).
        const acks = entry.idempotent ? -1 : cfg.acks;

        // Schema-encode the key and/or value when a schema id is supplied — the
        // registry returns a Confluent-framed Buffer; plain fields pass through as
        // strings (the producer serializer utf8-encodes them).
        const { registry } = entry;
        if ((cfg.valueSchemaId !== undefined || cfg.keySchemaId !== undefined) && !registry) {
          return {
            success: false,
            error: 'A schema ID requires a Schema Registry on this connection.',
          };
        }
        let messageKey: ProduceKV | undefined = cfg.key;
        let messageValue: ProduceKV = cfg.value;
        if (registry && cfg.valueSchemaId !== undefined) {
          const r = await encodeSchemaField(registry, cfg.valueSchemaId, cfg.value, 'value');
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
        }
        try {
          const result = await entry.producer.send({
            messages: [
              {
                topic: cfg.topic,
                // string (plain) or Buffer (registry-encoded) — the producer's
                // Buffer-or-string serializer handles both.
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
    createValidatedHandler(IPC.kafka.subscribe, KafkaSubscribeSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (!entry) {
        return { success: false, error: 'Not connected' };
      }
      if (entry.consumer) {
        return { success: false, error: 'Already subscribed — unsubscribe first' };
      }
      try {
        const kafka = getKafka();
        // Always hand back raw Buffers for key/value; the handler decodes them via
        // the registry (off the Confluent wire framing) in bindStreamListeners, so
        // key and value are decoded symmetrically (headers stay UTF-8 strings).
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
        const consumer = new kafka.Consumer<Buffer, Buffer, string, string>(consumerOptions);

        // Start-position precedence:
        //   1. explicit per-partition `offsets` → MANUAL seek (offset is bigint)
        //   2. explicit `mode` (latest/earliest/manual)
        //   3. legacy `fromBeginning` (EARLIEST vs LATEST)
        // MANUAL requires the caller to know partition numbers; the lib seeks to
        // each (topic, partition) → offset triple supplied in `offsets`.
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
        } else if (cfg.mode === 'manual') {
          // 'manual' with no offsets is meaningless — fall back to LATEST.
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

        bindStreamListeners(entry, stream);
        entry.consumer = consumer;
        entry.stream = stream;
        return { success: true };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    })
  );

  ipcMain.handle(
    IPC.kafka.unsubscribe,
    createValidatedHandler(IPC.kafka.unsubscribe, KafkaUnsubscribeSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (!entry) return { success: false, error: 'Not connected' };
      await closeConsumerAndStream(entry);
      return { success: true };
    })
  );

  ipcMain.handle(
    IPC.kafka.disconnect,
    createValidatedHandler(IPC.kafka.disconnect, KafkaDisconnectSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (entry) {
        await closeConnection(entry);
        activeConnections.delete(cfg.connectionId);
        emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CLOSE, cfg.connectionId), {});
      }
      return { success: true };
    })
  );

  // ---- Admin (topic + consumer-group management) -------------------------
  // Each op builds a short-lived Admin client from the connection's already-
  // validated clientOptions (auth/TLS reused), runs the call, and closes it in
  // a finally so broker sockets are released. Brokers were SSRF-guarded at
  // connect, so we don't re-run assertKafkaBrokersSafe here.

  ipcMain.handle(
    IPC.kafka.listTopics,
    createValidatedHandler(IPC.kafka.listTopics, KafkaListTopicsSchema, (cfg) =>
      withAdmin(cfg.connectionId, async (admin) => ({ topics: await admin.listTopics() }))
    )
  );

  ipcMain.handle(
    IPC.kafka.createTopic,
    createValidatedHandler(IPC.kafka.createTopic, KafkaCreateTopicSchema, (cfg) =>
      withAdmin(cfg.connectionId, async (admin) => {
        await admin.createTopics({
          topics: [cfg.topic],
          partitions: cfg.partitions,
          replicas: cfg.replicationFactor,
        });
        return {};
      })
    )
  );

  ipcMain.handle(
    IPC.kafka.deleteTopic,
    createValidatedHandler(IPC.kafka.deleteTopic, KafkaDeleteTopicSchema, (cfg) =>
      withAdmin(cfg.connectionId, async (admin) => {
        await admin.deleteTopics({ topics: [cfg.topic] });
        return {};
      })
    )
  );

  ipcMain.handle(
    IPC.kafka.listGroups,
    createValidatedHandler(IPC.kafka.listGroups, KafkaListGroupsSchema, (cfg) =>
      withAdmin(cfg.connectionId, async (admin) => {
        const groupsMap = await admin.listGroups();
        // listGroups returns a Map keyed by group id — flatten to a serializable
        // array for the renderer (Maps don't survive structured clone usefully).
        const groups = Array.from(groupsMap.values()).map((g) => ({
          id: g.id,
          state: String(g.state),
          groupType: g.groupType,
          protocolType: g.protocolType,
        }));
        return { groups };
      })
    )
  );
}

/**
 * Run an admin op against a short-lived Admin client for `connectionId`,
 * reusing the connection's validated auth/TLS. Owns the not-connected guard and
 * the finally-close so each call site can't leak a broker socket. `fn` returns
 * only the success payload; the wrapper stamps `success: true`.
 */
async function withAdmin<T extends object>(
  connectionId: string,
  fn: (admin: Admin) => Promise<T>
): Promise<({ success: true } & T) | { success: false; error: string }> {
  const entry = activeConnections.get(connectionId);
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
  // AdminOptions extends BaseOptions (clientId, bootstrapBrokers, sasl, tls) —
  // the same shape KafkaClientOptions carries. No serializers needed.
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
  for (const [, entry] of activeConnections) {
    await closeConnection(entry);
  }
  activeConnections.clear();
}
