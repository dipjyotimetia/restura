import type { KafkaMessageInput } from '@/features/kafka/store/useKafkaStore';
import type { KafkaSchemaRefIpc } from '../../../../electron/types/electron-api';

/**
 * Consumed records are buffered and flushed to the store on this interval
 * rather than per record (the shared `CoalescingBuffer`). A busy topic can
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
