import { ipcMain, webContents } from 'electron';
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
  /** Cached client options so a later consumer can reuse auth/TLS/brokers. */
  clientOptions: KafkaClientOptions;
  connectionId: string;
  webContentsId: number;
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

function emitTo(webContentsId: number, channel: string, ...args: unknown[]): void {
  const wc = webContents.fromId(webContentsId);
  if (wc && !wc.isDestroyed()) {
    wc.send(channel, ...args);
  }
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
    // Pass-through to Node's TLS layer (see @platformatic/kafka base options).
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

async function closeConnection(entry: ActiveKafka): Promise<void> {
  if (entry.stream) {
    try {
      await (entry.stream.close() as unknown as Promise<void>);
    } catch {
      /* ignore */
    }
    entry.stream = undefined;
  }
  if (entry.consumer) {
    try {
      await (entry.consumer.close(true) as unknown as Promise<void>);
    } catch {
      /* ignore */
    }
    entry.consumer = undefined;
  }
  try {
    await (entry.producer.close(true) as unknown as Promise<void>);
  } catch {
    /* ignore */
  }
}

export function registerKafkaHandlerIPC(): void {
  ipcMain.handle('kafka:connect', async (event, rawConfig: unknown) => {
    const cfg = validateIpcInput(KafkaConnectSchema, rawConfig, 'kafka:connect');
    const { connectionId } = cfg;
    const webContentsId = event.sender.id;

    if (!kafkaRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    if (activeConnections.size >= MAX_CONCURRENT_KAFKA_CONNECTIONS) {
      return { success: false, error: 'Too many open Kafka connections.' };
    }

    // Replace any prior connection with the same id
    const existing = activeConnections.get(connectionId);
    if (existing) {
      await closeConnection(existing);
      activeConnections.delete(connectionId);
    }

    try {
      const clientOptions = buildClientOptions(cfg);
      const producerOptions = {
        ...clientOptions,
        serializers: stringSerializers,
      } as unknown as ProducerOptions<string, string, string, string>;
      const producer = new Producer<string, string, string, string>(producerOptions);

      // @platformatic/kafka producers connect lazily; auth/TLS/host errors
      // surface on the first send. We can't reliably eagerly verify because
      // some brokers reject `metadata({ topics: [] })`. Skip the pre-fetch
      // and trust the user's first produce to surface failures with a
      // proper error code.

      const entry: ActiveKafka = {
        producer,
        clientOptions,
        connectionId,
        webContentsId,
        createdAt: Date.now(),
      };
      activeConnections.set(connectionId, entry);
      emitTo(webContentsId, `kafka:connected:${connectionId}`, { timestamp: Date.now() });
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
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
        // Bind a new Consumer to the same brokers + auth used by the producer.
        // @platformatic/kafka requires a separate Consumer instance (it owns
        // its own connection pool and group lifecycle).
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

        stream.on('data', (msg: StringMessage) => {
          emitTo(entry.webContentsId, `kafka:message:${cfg.connectionId}`, {
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
          emitTo(entry.webContentsId, `kafka:error:${cfg.connectionId}`, {
            scope: 'consumer',
            message: err.message,
          });
        });

        stream.on('close', () => {
          emitTo(entry.webContentsId, `kafka:consumer-closed:${cfg.connectionId}`, {});
        });

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
      if (entry.stream) {
        try { await entry.stream.close(); } catch { /* ignore */ }
        entry.stream = undefined;
      }
      if (entry.consumer) {
        try { await entry.consumer.close(true); } catch { /* ignore */ }
        entry.consumer = undefined;
      }
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
        emitTo(entry.webContentsId, `kafka:close:${cfg.connectionId}`, {});
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
