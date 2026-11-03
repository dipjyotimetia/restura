import type * as KafkaLib from '@platformatic/kafka';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/channels';
import type { KafkaAck } from '../../../types/api/protocols';
import { errorMessage } from '../../ipc/ipc-utils';
import {
  createValidatedEventHandler,
  type KafkaProduceBatchConfig,
  KafkaProduceBatchSchema,
  type KafkaProduceConfig,
  KafkaProducerStreamCloseSchema,
  type KafkaProducerStreamOpenConfig,
  KafkaProducerStreamOpenSchema,
  type KafkaProducerStreamWriteConfig,
  KafkaProducerStreamWriteSchema,
  KafkaProduceSchema,
  type KafkaTransactionBeginConfig,
  KafkaTransactionBeginSchema,
  type KafkaTransactionEndConfig,
  KafkaTransactionEndSchema,
} from '../../ipc/ipc-validators';
import { decodeWirePayload, encodeSchemaField } from '../kafka-serde';
import { addTopicPartition } from './partition-pause';
import { type KafkaRegistryClient, resolveFieldSchemaId } from './registry';

export type AppProducer = KafkaLib.Producer<Buffer, Buffer, Buffer, Buffer>;
type AppProducerStream = KafkaLib.ProducerStream<Buffer, Buffer, Buffer, Buffer>;
type AppTransaction = Awaited<ReturnType<AppProducer['beginTransaction']>>;
type AppProduceMessage = KafkaLib.MessageToProduce<Buffer, Buffer, Buffer, Buffer>;
type KafkaRecordConfig = KafkaProduceConfig['record'];

export interface KafkaProducerEntry {
  producer: AppProducer;
  producerStream?: AppProducerStream;
  /** Why the last producer stream failed; cleared by the next open/close. */
  producerStreamError?: string;
  transaction?: AppTransaction;
  /** A beginTransaction is awaiting the broker (guards concurrent begins). */
  transactionStarting?: boolean;
  idempotent: boolean;
  transactionalId?: string;
  registry?: KafkaRegistryClient;
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
    const resolved = await resolveFieldSchemaId(entry.registry, field);
    if ('error' in resolved) return resolved;
    const encoded = await encodeSchemaField(entry.registry, resolved.schemaId, field.data, name);
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

/**
 * One ack per record, in record order. ProduceResult carries one base offset
 * per partition; records sent to the same partition in one request occupy
 * consecutive offsets in send order, so a record's offset is that base plus
 * its position among the batch's records for that partition. A record without
 * an explicit partition is attributable only when its topic resolved to a
 * single partition; otherwise the per-partition base offsets are returned
 * unchanged (one ack per partition, not per record).
 */
function acknowledgements(
  records: KafkaRecordConfig[],
  result: KafkaLib.ProduceResult
): KafkaAck[] {
  const now = Date.now();
  if (!result.offsets?.length) {
    return records.map((record) => ({
      topic: record.topic,
      partition: record.partition ?? -1,
      offset: '-1',
      timestamp: now,
    }));
  }
  const perPartition = (): KafkaAck[] =>
    (result.offsets ?? []).map((offset) => ({
      topic: offset.topic,
      partition: offset.partition,
      offset: offset.offset.toString(),
      timestamp: now,
    }));
  const base = new Map<string, bigint>();
  const partitionsByTopic = new Map<string, number[]>();
  for (const { topic, partition, offset } of result.offsets) {
    base.set(`${topic}:${partition}`, offset);
    addTopicPartition(partitionsByTopic, topic, partition);
  }
  const seen = new Map<string, bigint>();
  const acks: KafkaAck[] = [];
  for (const record of records) {
    const only = partitionsByTopic.get(record.topic);
    const partition = record.partition ?? (only?.length === 1 ? only[0] : undefined);
    if (partition === undefined) return perPartition();
    const key = `${record.topic}:${partition}`;
    const start = base.get(key);
    if (start === undefined || start < 0n) return perPartition();
    const index = seen.get(key) ?? 0n;
    seen.set(key, index + 1n);
    acks.push({
      topic: record.topic,
      partition,
      offset: (start + index).toString(),
      timestamp: now,
    });
  }
  return acks;
}

/** Bound on flushing an open producer stream during disconnect. */
const PRODUCER_STREAM_DRAIN_MS = 10_000;

/** The stream's failure once the library destroyed it (a failed batch does). */
function streamFailure(stream: AppProducerStream): Error | undefined {
  if (stream.errored) return stream.errored;
  return stream.destroyed ? new Error('The producer stream was closed.') : undefined;
}

/**
 * End the stream and wait until its buffered records are flushed. Resolves at
 * once for a stream the library already destroyed (after a failed batch
 * 'finish' never comes) and also on 'close', so it cannot hang.
 */
function endProducerStream(stream: AppProducerStream, timeoutMs?: number): Promise<void> {
  if (stream.destroyed || stream.writableFinished) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (err?: Error | null) => {
      if (timer) clearTimeout(timer);
      stream.removeListener('finish', onFinish);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onFinish = () => settle();
    const onError = (err: Error) => settle(err);
    const onClose = () => settle(stream.errored);
    stream.once('finish', onFinish);
    stream.once('error', onError);
    stream.once('close', onClose);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        settle(new Error('Flushing the producer stream timed out.'));
        stream.destroy();
      }, timeoutMs);
    }
    stream.end();
  });
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
  const stream = entry.producerStream;
  entry.producerStream = undefined;
  entry.producerStreamError = undefined;
  if (stream) {
    // Let buffered records reach the broker before the producer closes.
    try {
      await endProducerStream(stream, PRODUCER_STREAM_DRAIN_MS);
    } catch {
      /* ignore — the producer is closing anyway */
    }
  }
}

export function registerKafkaProducerHandlers<E extends KafkaProducerEntry>(
  getEntry: (connectionId: string, ownerId: number) => E | undefined,
  /** Report a producer-stream failure that happened outside any IPC call. */
  onStreamError: (entry: E, err: Error) => void = () => {}
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
        const stream = entry.producer.asStream({
          acks: entry.idempotent ? -1 : cfg.acks,
          ...(cfg.compression && cfg.compression !== 'none'
            ? { compression: cfg.compression }
            : {}),
          ...(cfg.highWaterMark ? { highWaterMark: cfg.highWaterMark } : {}),
          ...(cfg.batchSize ? { batchSize: cfg.batchSize } : {}),
          ...(cfg.batchTime !== undefined ? { batchTime: cfg.batchTime } : {}),
          reportMode: 'batch',
        });
        // A failed batch makes the library destroy the stream with the error.
        // Without a listener that is an uncaughtException in main, and the dead
        // stream would keep "accepting" writes that never reach the broker.
        stream.on('error', (err: Error) => {
          if (entry.producerStream !== stream) return;
          entry.producerStream = undefined;
          entry.producerStreamError = errorMessage(err);
          onStreamError(entry, err);
        });
        entry.producerStream = stream;
        entry.producerStreamError = undefined;
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
        const encoded = await encodeProduceRecord(entry, cfg.record);
        if ('error' in encoded) return { success: false, error: encoded.error };
        const stream = entry.producerStream;
        // The library destroys the stream synchronously but emits 'error' a tick later.
        const failure = stream ? streamFailure(stream)?.message : entry.producerStreamError;
        if (failure) {
          return {
            success: false,
            error: `The producer stream failed: ${failure.replace(/\.$/, '')}. Close it and open a new one.`,
          };
        }
        if (!stream) return { success: false, error: 'No producer stream is open.' };
        // false = buffered past the high-water mark (backpressure), not dropped.
        return { success: true, accepted: stream.write(encoded.message) };
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
        // A stream that already failed was reported on the Kafka error channel.
        entry.producerStreamError = undefined;
        if (!stream) return { success: true };
        entry.producerStream = undefined;
        try {
          await endProducerStream(stream);
          return { success: true };
        } catch (err) {
          return { success: false, error: errorMessage(err) };
        }
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
        // While a begin awaits FindCoordinator / InitProducerId, a second one
        // would get the library's "already active" error and its failure path
        // would cancel the first, in-flight transaction.
        if (entry.transactionStarting) {
          return { success: false, error: 'A transaction is already being started.' };
        }
        entry.transactionStarting = true;
        try {
          const transaction = await entry.producer.beginTransaction({ idempotent: true, acks: -1 });
          entry.transaction = transaction;
          return { success: true, transactionId: transaction.id };
        } catch (err) {
          // The library records its transaction before FindCoordinator /
          // InitProducerId run, so a failed prepare would leave the producer
          // "in use by a transaction" until reconnect. Nothing is open on the
          // broker yet, so cancelling (local state only) is enough.
          const stale = entry.producer.transaction;
          if (stale && !stale.completed) {
            try {
              await stale.cancel();
            } catch {
              /* ignore — reconnecting also clears it */
            }
          }
          return { success: false, error: errorMessage(err) };
        } finally {
          entry.transactionStarting = false;
        }
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
        // The library releases its transaction only once EndTxn succeeds, so
        // ours stays too: a failed commit can be retried or aborted.
        try {
          if (cfg.action === 'commit') await transaction.commit();
          else await transaction.abort();
          if (entry.transaction === transaction) entry.transaction = undefined;
          return { success: true };
        } catch (err) {
          if (transaction.completed) {
            if (entry.transaction === transaction) entry.transaction = undefined;
            return { success: false, error: errorMessage(err) };
          }
          // Fenced (e.g. INVALID_PRODUCER_EPOCH after the broker timed the
          // transaction out): the library dropped it without marking it
          // completed, and every retry would fail "in use by another transaction".
          if (entry.producer.transaction !== transaction) {
            if (entry.transaction === transaction) entry.transaction = undefined;
            return {
              success: false,
              error: `${errorMessage(err)} The broker aborted the transaction (fenced or timed out); its records were not committed. Begin a new transaction; if the broker still refuses the transactional ID (it can hold a fenced ID for a while), reconnect or use a different transactional ID.`,
            };
          }
          const next =
            cfg.action === 'commit'
              ? 'Retry the commit or abort it.'
              : 'Retry the abort, or reconnect to reset the producer.';
          return {
            success: false,
            error: `${errorMessage(err)} The transaction is still open. ${next}`,
          };
        }
      }
    )
  );
}
