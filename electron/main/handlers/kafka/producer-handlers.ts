import type * as KafkaLib from '@platformatic/kafka';
import { ipcMain } from 'electron';
import type { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import { IPC } from '../../../shared/channels';
import type { KafkaAck } from '../../../types/api/protocols';
import {
  createValidatedEventHandler,
  type KafkaProduceBatchConfig,
  KafkaProduceBatchSchema,
  type KafkaProduceConfig,
  KafkaProduceSchema,
  type KafkaProducerStreamOpenConfig,
  KafkaProducerStreamOpenSchema,
  type KafkaProducerStreamWriteConfig,
  KafkaProducerStreamWriteSchema,
  KafkaProducerStreamCloseSchema,
  type KafkaTransactionBeginConfig,
  KafkaTransactionBeginSchema,
  type KafkaTransactionEndConfig,
  KafkaTransactionEndSchema,
} from '../../ipc/ipc-validators';
import { errorMessage } from '../../ipc/ipc-utils';
import { decodeWirePayload, encodeSchemaField } from '../kafka-serde';

export type AppProducer = KafkaLib.Producer<Buffer, Buffer, Buffer, Buffer>;
type AppProducerStream = KafkaLib.ProducerStream<Buffer, Buffer, Buffer, Buffer>;
type AppTransaction = Awaited<ReturnType<AppProducer['beginTransaction']>>;
type AppProduceMessage = KafkaLib.MessageToProduce<Buffer, Buffer, Buffer, Buffer>;
type KafkaRecordConfig = KafkaProduceConfig['record'];

export interface KafkaProducerEntry {
  producer: AppProducer;
  producerStream?: AppProducerStream;
  transaction?: AppTransaction;
  idempotent: boolean;
  transactionalId?: string;
  registry?: SchemaRegistry;
}

async function encodeRecordField(
  entry: KafkaProducerEntry,
  field: KafkaRecordConfig['value'],
  name: 'key' | 'value'
): Promise<{ value?: Buffer } | { error: string }> {
  if (field.encoding === 'null') return { value: undefined };
  if (field.encoding === 'schema') {
    if (!entry.registry) {
      return { error: 'A schema field requires a Schema Registry on this connection.' };
    }
    const encoded = await encodeSchemaField(entry.registry, field.schemaId, field.data, name);
    return 'error' in encoded
      ? encoded
      : { value: Buffer.isBuffer(encoded.value) ? encoded.value : Buffer.from(encoded.value) };
  }
  const decoded = decodeWirePayload(field.data, field.encoding, name);
  return 'error' in decoded
    ? decoded
    : { value: Buffer.isBuffer(decoded.value) ? decoded.value : Buffer.from(decoded.value) };
}

async function encodeProduceRecord(
  entry: KafkaProducerEntry,
  record: KafkaRecordConfig
): Promise<{ message: AppProduceMessage } | { error: string }> {
  const value = await encodeRecordField(entry, record.value, 'value');
  if ('error' in value) return value;
  const key = record.key ? await encodeRecordField(entry, record.key, 'key') : undefined;
  if (key && 'error' in key) return key;
  const headers = record.headers
    ? new Map(
        record.headers.map((header) => [
          Buffer.from(header.key.data, header.key.encoding),
          Buffer.from(header.value.data, header.value.encoding),
        ])
      )
    : undefined;
  return {
    message: {
      topic: record.topic,
      ...(key?.value !== undefined ? { key: key.value } : {}),
      ...(value.value !== undefined ? { value: value.value } : {}),
      ...(headers ? { headers } : {}),
      ...(record.partition !== undefined ? { partition: record.partition } : {}),
      ...(record.timestamp !== undefined ? { timestamp: BigInt(record.timestamp) } : {}),
    },
  };
}

function acknowledgements(
  records: KafkaRecordConfig[],
  result: KafkaLib.ProduceResult
): KafkaAck[] {
  if (!result.offsets?.length) {
    return records.map((record) => ({
      topic: record.topic,
      partition: record.partition ?? -1,
      offset: '-1',
      timestamp: Date.now(),
    }));
  }
  return result.offsets.map((offset) => ({
    topic: offset.topic,
    partition: offset.partition,
    offset: offset.offset.toString(),
    timestamp: Date.now(),
  }));
}

async function sendRecords(
  entry: KafkaProducerEntry,
  records: KafkaRecordConfig[],
  options: { acks: 0 | 1 | -1; compression?: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd' }
): Promise<{ success: boolean; acks?: KafkaAck[]; error?: string }> {
  const messages: AppProduceMessage[] = [];
  for (const record of records) {
    const encoded = await encodeProduceRecord(entry, record);
    if ('error' in encoded) return { success: false, error: encoded.error };
    messages.push(encoded.message);
  }
  try {
    const sendOptions = {
      messages,
      acks: entry.idempotent ? -1 : options.acks,
      ...(options.compression && options.compression !== 'none'
        ? { compression: options.compression }
        : {}),
    };
    const result = entry.transaction
      ? await entry.transaction.send(sendOptions)
      : await entry.producer.send(sendOptions);
    return { success: true, acks: acknowledgements(records, result) };
  } catch (err) {
    return { success: false, error: errorMessage(err) };
  }
}

export async function closeKafkaProducerSessions(entry: KafkaProducerEntry): Promise<void> {
  if (entry.transaction && !entry.transaction.completed) {
    try {
      await entry.transaction.abort();
    } catch {
      /* ignore */
    }
    entry.transaction = undefined;
  }
  if (entry.producerStream) {
    try {
      entry.producerStream.end();
    } catch {
      /* ignore */
    }
    entry.producerStream = undefined;
  }
}

export function registerKafkaProducerHandlers(
  getEntry: (connectionId: string, ownerId: number) => KafkaProducerEntry | undefined
): void {
  ipcMain.handle(
    IPC.kafka.produce,
    createValidatedEventHandler(
      IPC.kafka.produce,
      KafkaProduceSchema,
      async (cfg: KafkaProduceConfig, event) => {
        const entry = getEntry(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        const result = await sendRecords(entry, [cfg.record], cfg);
        return result.success
          ? { success: true, ack: result.acks?.[0] }
          : { success: false, error: result.error };
      }
    )
  );

  ipcMain.handle(
    IPC.kafka.produceBatch,
    createValidatedEventHandler(
      IPC.kafka.produceBatch,
      KafkaProduceBatchSchema,
      async (cfg: KafkaProduceBatchConfig, event) => {
        const entry = getEntry(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        return sendRecords(entry, cfg.records, cfg);
      }
    )
  );

  ipcMain.handle(
    IPC.kafka.openProducerStream,
    createValidatedEventHandler(
      IPC.kafka.openProducerStream,
      KafkaProducerStreamOpenSchema,
      async (cfg: KafkaProducerStreamOpenConfig, event) => {
        const entry = getEntry(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        if (entry.transaction) return { success: false, error: 'A transaction session is active.' };
        if (entry.producerStream) {
          return { success: false, error: 'A producer stream is already open.' };
        }
        entry.producerStream = entry.producer.asStream({
          acks: entry.idempotent ? -1 : cfg.acks,
          ...(cfg.compression && cfg.compression !== 'none'
            ? { compression: cfg.compression }
            : {}),
          ...(cfg.highWaterMark ? { highWaterMark: cfg.highWaterMark } : {}),
          ...(cfg.batchSize ? { batchSize: cfg.batchSize } : {}),
          ...(cfg.batchTime !== undefined ? { batchTime: cfg.batchTime } : {}),
          reportMode: 'batch',
        });
        return { success: true };
      }
    )
  );

  ipcMain.handle(
    IPC.kafka.writeProducerStream,
    createValidatedEventHandler(
      IPC.kafka.writeProducerStream,
      KafkaProducerStreamWriteSchema,
      async (cfg: KafkaProducerStreamWriteConfig, event) => {
        const entry = getEntry(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        if (!entry.producerStream) return { success: false, error: 'No producer stream is open.' };
        const encoded = await encodeProduceRecord(entry, cfg.record);
        if ('error' in encoded) return { success: false, error: encoded.error };
        return { success: true, accepted: entry.producerStream.write(encoded.message) };
      }
    )
  );

  ipcMain.handle(
    IPC.kafka.closeProducerStream,
    createValidatedEventHandler(
      IPC.kafka.closeProducerStream,
      KafkaProducerStreamCloseSchema,
      async (cfg, event) => {
        const entry = getEntry(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        const stream = entry.producerStream;
        if (!stream) return { success: true };
        entry.producerStream = undefined;
        await new Promise<void>((resolve, reject) => {
          stream.once('finish', resolve);
          stream.once('error', reject);
          stream.end();
        });
        return { success: true };
      }
    )
  );

  ipcMain.handle(
    IPC.kafka.beginTransaction,
    createValidatedEventHandler(
      IPC.kafka.beginTransaction,
      KafkaTransactionBeginSchema,
      async (cfg: KafkaTransactionBeginConfig, event) => {
        const entry = getEntry(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        if (!entry.transactionalId) {
          return { success: false, error: 'Reconnect with a transactional ID first.' };
        }
        if (entry.producerStream)
          return { success: false, error: 'Close the producer stream first.' };
        if (entry.transaction) return { success: false, error: 'A transaction is already active.' };
        const transaction = await entry.producer.beginTransaction({ idempotent: true, acks: -1 });
        entry.transaction = transaction;
        return { success: true, transactionId: transaction.id };
      }
    )
  );

  ipcMain.handle(
    IPC.kafka.endTransaction,
    createValidatedEventHandler(
      IPC.kafka.endTransaction,
      KafkaTransactionEndSchema,
      async (cfg: KafkaTransactionEndConfig, event) => {
        const entry = getEntry(cfg.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        const transaction = entry.transaction;
        if (!transaction) return { success: false, error: 'No transaction is active.' };
        entry.transaction = undefined;
        try {
          if (cfg.action === 'commit') await transaction.commit();
          else await transaction.abort();
          return { success: true };
        } catch (err) {
          return { success: false, error: errorMessage(err) };
        }
      }
    )
  );
}
