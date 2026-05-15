/**
 * IPC channel prefixes for the Kafka protocol. Shared between the Electron
 * main process (which emits) and the renderer (which subscribes) so that
 * a rename never silently desyncs the two sides.
 *
 * Each prefix is suffixed at runtime with the connection id, e.g.
 * `kafka:message:<connectionId>`.
 */
export const KAFKA_CHANNEL = {
  /** Connected handshake — sent once after the producer is constructed. */
  CONNECTED: 'kafka:connected:',
  /** A consumer record arrived. */
  MESSAGE: 'kafka:message:',
  /** Producer or consumer error (with `{ scope, message }` payload). */
  ERROR: 'kafka:error:',
  /** The consumer stream closed but the producer is still alive. */
  CONSUMER_CLOSED: 'kafka:consumer-closed:',
  /** The whole connection (producer + consumer) was torn down. */
  CLOSE: 'kafka:close:',
} as const;

export type KafkaChannelPrefix = (typeof KAFKA_CHANNEL)[keyof typeof KAFKA_CHANNEL];

export function kafkaChannel(prefix: KafkaChannelPrefix, connectionId: string): string {
  return `${prefix}${connectionId}`;
}
