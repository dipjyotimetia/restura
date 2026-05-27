/**
 * Kafka IPC channel prefixes. Kept as a thin compatibility shim over the
 * unified registry in `./channels.ts` (the single source of truth) so existing
 * `KAFKA_CHANNEL` / `kafkaChannel` call sites — in `kafka-handler.ts` and the
 * renderer's `kafkaManager.ts` — keep working without churn.
 *
 * Each prefix is suffixed at runtime with the connection id, e.g.
 * `kafka:message:<connectionId>`.
 */
import { EVENT_PREFIX, eventChannel } from './channels';

export const KAFKA_CHANNEL = {
  /** Connected handshake — sent once after the producer is constructed. */
  CONNECTED: EVENT_PREFIX.kafka.connected,
  /** A consumer record arrived. */
  MESSAGE: EVENT_PREFIX.kafka.message,
  /** Producer or consumer error (with `{ scope, message }` payload). */
  ERROR: EVENT_PREFIX.kafka.error,
  /** The consumer stream closed but the producer is still alive. */
  CONSUMER_CLOSED: EVENT_PREFIX.kafka.consumerClosed,
  /** The whole connection (producer + consumer) was torn down. */
  CLOSE: EVENT_PREFIX.kafka.close,
} as const;

export type KafkaChannelPrefix = (typeof KAFKA_CHANNEL)[keyof typeof KAFKA_CHANNEL];

export function kafkaChannel(prefix: KafkaChannelPrefix, connectionId: string): string {
  return eventChannel(prefix, connectionId);
}
