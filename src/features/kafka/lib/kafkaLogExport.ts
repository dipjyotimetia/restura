import type { KafkaMessage } from '@/features/kafka/store/useKafkaStore';
import type { LogEntry } from '@/lib/shared/messageLog';

const DIRECTION = { sent: 'out', received: 'in', system: 'system' } as const;

/** Kafka records in the shared message-log shape (for export). */
export function kafkaToLogEntries(messages: readonly KafkaMessage[]): LogEntry[] {
  return messages.map((m) => ({
    id: m.id,
    timestamp: m.timestamp,
    direction: m.error ? 'error' : DIRECTION[m.direction],
    label:
      m.partition === undefined
        ? m.topic
        : `${m.topic}[${m.partition}]${m.offset === undefined ? '' : `@${m.offset}`}`,
    body: m.error ?? m.value,
  }));
}
