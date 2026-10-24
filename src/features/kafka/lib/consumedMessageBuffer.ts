import type { KafkaMessageInput } from '@/features/kafka/store/useKafkaStore';
import { MAX_MESSAGES_PER_CONNECTION } from '@/lib/shared/message-cap';
import type { KafkaSchemaRefIpc } from '../../../../electron/types/electron-api';

/**
 * Consumed records are buffered and flushed to the store on this interval
 * rather than per record (mirrors the MQTT inbound path). A busy topic can
 * deliver thousands of records per second; coalescing keeps the store update,
 * console-frame write and message-list re-render at ~10 Hz per connection.
 */
export const KAFKA_FLUSH_INTERVAL_MS = 100;

/** Wire shape of a `kafka:message:<id>` event from the Electron main process. */
export interface KafkaConsumedPayload {
  topic: string;
  partition: number;
  offset: string;
  key?: string;
  keyEncoding?: 'utf8' | 'base64';
  keySchema?: KafkaSchemaRefIpc;
  value: string;
  valueEncoding?: 'utf8' | 'base64';
  valueSchema?: KafkaSchemaRefIpc;
  tombstone?: boolean;
  headers?: Record<string, string>;
  binaryHeaders?: { key: string; value: string }[];
  commitToken?: string;
  timestamp: number;
}

export function toReceivedMessage(msg: KafkaConsumedPayload): KafkaMessageInput {
  return {
    direction: 'received',
    topic: msg.topic,
    partition: msg.partition,
    offset: msg.offset,
    ...(msg.key !== undefined ? { key: msg.key } : {}),
    ...(msg.keyEncoding !== undefined ? { keyEncoding: msg.keyEncoding } : {}),
    ...(msg.keySchema ? { keySchema: msg.keySchema } : {}),
    ...(msg.valueSchema ? { valueSchema: msg.valueSchema } : {}),
    value: msg.tombstone ? '<tombstone>' : msg.value,
    ...(msg.tombstone ? { tombstone: true } : {}),
    ...(msg.valueEncoding !== undefined ? { valueEncoding: msg.valueEncoding } : {}),
    ...(msg.headers ? { headers: msg.headers } : {}),
    ...(msg.binaryHeaders ? { binaryHeaders: msg.binaryHeaders } : {}),
    // The commit token is the only handle back to the main-process record in
    // manual-commit mode; it must survive batching untouched.
    ...(msg.commitToken ? { commitToken: msg.commitToken } : {}),
    timestamp: msg.timestamp,
  };
}

/**
 * Per-connection inbound buffer. The first record after a flush arms a single
 * timer; everything arriving before it fires lands in one `sink` call, in
 * arrival order. `flush` drains synchronously so lifecycle messages (consumer
 * closed, errors, unsubscribe) never overtake records that arrived before them.
 */
export class ConsumedMessageBuffer {
  private readonly buffers = new Map<string, KafkaMessageInput[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly sink: (connectionId: string, batch: KafkaMessageInput[]) => void,
    private readonly intervalMs = KAFKA_FLUSH_INTERVAL_MS,
    private readonly maxBuffered = MAX_MESSAGES_PER_CONNECTION
  ) {}

  push(connectionId: string, message: KafkaMessageInput): void {
    const buf = this.buffers.get(connectionId);
    if (buf) {
      buf.push(message);
      // The store keeps only the newest N anyway; don't hold more between flushes.
      if (buf.length > this.maxBuffered) buf.splice(0, buf.length - this.maxBuffered);
    } else this.buffers.set(connectionId, [message]);
    if (!this.timers.has(connectionId)) {
      this.timers.set(
        connectionId,
        setTimeout(() => this.flush(connectionId), this.intervalMs)
      );
    }
  }

  /** Drop pending records without delivering them (the log was cleared). */
  discard(connectionId: string): void {
    this.cancelTimer(connectionId);
    this.buffers.delete(connectionId);
  }

  flush(connectionId: string): void {
    this.cancelTimer(connectionId);
    const buf = this.buffers.get(connectionId);
    if (!buf || buf.length === 0) return;
    this.buffers.delete(connectionId);
    this.sink(connectionId, buf);
  }

  private cancelTimer(connectionId: string): void {
    const timer = this.timers.get(connectionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(connectionId);
  }
}
