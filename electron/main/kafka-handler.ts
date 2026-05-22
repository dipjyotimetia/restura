import { ipcMain, webContents } from 'electron';
import type { WebContents } from 'electron';
import {
  Consumer,
  MessagesStreamModes,
  Producer,
  stringDeserializers,
  stringSerializers,
} from '@platformatic/kafka';
import type {
  ConsumerOptions,
  Message,
  MessagesStream,
  ProducerOptions,
} from '@platformatic/kafka';
import { createKeyedRateLimiter } from './ipc-rate-limiter';
import { emitTo } from './ipc-utils';
import { KAFKA_CHANNEL, kafkaChannel } from '../shared/kafka-channels';
import { assertKafkaBrokersSafe } from './kafka-broker-guard';
import type { LogEntry } from './request-logger';
import {
  KafkaConnectSchema,
  KafkaProduceSchema,
  KafkaSubscribeSchema,
  KafkaUnsubscribeSchema,
  KafkaDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
  type KafkaConnectConfig,
  type KafkaProduceConfig,
} from './ipc-validators';

export const kafkaRateLimiter = createKeyedRateLimiter(120, 60_000);

const MAX_CONCURRENT_KAFKA_CONNECTIONS = 20;

type StringProducer = Producer<string, string, string, string>;
type StringConsumer = Consumer<string, string, string, string>;
type StringStream = MessagesStream<string, string, string, string>;
type StringMessage = Message<string, string, string, string>;

interface ActiveKafka {
  producer: StringProducer;
  consumer?: StringConsumer;
  stream?: StringStream;
  clientOptions: KafkaClientOptions;
  connectionId: string;
  webContentsId: number;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildClientOptions(cfg: KafkaConnectConfig): KafkaClientOptions {
  const opts: KafkaClientOptions = {
    clientId: cfg.clientId,
    bootstrapBrokers: cfg.bootstrapBrokers,
  };

  const useTls =
    cfg.auth.securityProtocol === 'SSL' || cfg.auth.securityProtocol === 'SASL_SSL';

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

function bindStreamListeners(entry: ActiveKafka, stream: StringStream): void {
  stream.on('data', (msg: StringMessage) => {
    emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.MESSAGE, entry.connectionId), {
      topic: msg.topic,
      partition: msg.partition,
      offset: msg.offset.toString(),
      key: msg.key,
      value: msg.value,
      headers: headersFromMap(msg.headers as Map<string, string> | undefined),
      timestamp: typeof msg.timestamp === 'bigint' ? Number(msg.timestamp) : Date.now(),
    });
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
  ipcMain.handle('kafka:connect', async (event, rawConfig: unknown) => {
    const cfg = validateIpcInput(KafkaConnectSchema, rawConfig, 'kafka:connect');
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
    } catch (err) {
      const msg = errorMessage(err);
      logEntry(400, msg);
      return { success: false, error: msg };
    }

    try {
      const clientOptions = buildClientOptions(cfg);
      const producerOptions = {
        ...clientOptions,
        serializers: stringSerializers,
      } as unknown as ProducerOptions<string, string, string, string>;
      const producer = new Producer<string, string, string, string>(producerOptions);

      // @platformatic/kafka producers connect lazily; auth/TLS/host errors
      // surface on the first send rather than here. Metadata pre-fetch was
      // tried but some brokers reject `metadata({ topics: [] })`.
      const wc = webContents.fromId(webContentsId) ?? undefined;
      const entry: ActiveKafka = {
        producer,
        clientOptions,
        connectionId,
        webContentsId,
        ...(wc ? { wc } : {}),
        createdAt: Date.now(),
      };
      activeConnections.set(connectionId, entry);

      // Tear the connection down if the renderer dies without disconnecting.
      // Otherwise the producer/consumer keep their broker sockets open until
      // the Electron process exits — a real leak under hot-reload.
      wc?.once('destroyed', () => {
        const e = activeConnections.get(connectionId);
        if (e === entry) {
          activeConnections.delete(connectionId);
          void closeConnection(entry);
        }
      });

      emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CONNECTED, connectionId), { timestamp: Date.now() });
      logEntry(0);
      return { success: true };
    } catch (err) {
      const msg = errorMessage(err);
      logEntry(500, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(
    'kafka:produce',
    createValidatedHandler(
      'kafka:produce',
      KafkaProduceSchema,
      async (cfg: KafkaProduceConfig) => {
        const entry = activeConnections.get(cfg.connectionId);
        if (!entry) {
          return { success: false, error: 'Not connected' };
        }
        try {
          const result = await entry.producer.send({
            messages: [
              {
                topic: cfg.topic,
                ...(cfg.key !== undefined ? { key: cfg.key } : {}),
                value: cfg.value,
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
            acks: cfg.acks,
            ...(cfg.compression && cfg.compression !== 'none'
              ? { compression: cfg.compression }
              : {}),
          });

          const first = result.offsets?.[0];
          if (!first) {
            return {
              success: true,
              ack: { topic: cfg.topic, partition: cfg.partition ?? -1, offset: '-1', timestamp: Date.now() },
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
    'kafka:subscribe',
    createValidatedHandler('kafka:subscribe', KafkaSubscribeSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (!entry) {
        return { success: false, error: 'Not connected' };
      }
      if (entry.consumer) {
        return { success: false, error: 'Already subscribed — unsubscribe first' };
      }
      try {
        const consumerOptions = {
          ...entry.clientOptions,
          groupId: cfg.groupId,
          deserializers: stringDeserializers,
        } as unknown as ConsumerOptions<string, string, string, string>;
        const consumer = new Consumer<string, string, string, string>(consumerOptions);

        const stream = (await (consumer.consume({
          topics: cfg.topics,
          mode: cfg.fromBeginning ? MessagesStreamModes.EARLIEST : MessagesStreamModes.LATEST,
        }) as Promise<StringStream>));

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
    'kafka:unsubscribe',
    createValidatedHandler('kafka:unsubscribe', KafkaUnsubscribeSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (!entry) return { success: false, error: 'Not connected' };
      await closeConsumerAndStream(entry);
      return { success: true };
    })
  );

  ipcMain.handle(
    'kafka:disconnect',
    createValidatedHandler('kafka:disconnect', KafkaDisconnectSchema, async (cfg) => {
      const entry = activeConnections.get(cfg.connectionId);
      if (entry) {
        await closeConnection(entry);
        activeConnections.delete(cfg.connectionId);
        emitToEntry(entry, kafkaChannel(KAFKA_CHANNEL.CLOSE, cfg.connectionId), {});
      }
      return { success: true };
    })
  );
}

export async function stopKafkaCleanup(): Promise<void> {
  for (const [, entry] of activeConnections) {
    await closeConnection(entry);
  }
  activeConnections.clear();
}
