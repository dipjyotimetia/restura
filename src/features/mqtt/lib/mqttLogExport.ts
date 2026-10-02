import type { MqttMessage } from '@/features/mqtt/store/useMqttStore';
import type { LogEntry } from '@/lib/shared/messageLog';

const DIRECTION = { sent: 'out', received: 'in', system: 'system' } as const;

/** MQTT messages in the shared message-log shape (for export). */
export function mqttToLogEntries(messages: readonly MqttMessage[]): LogEntry[] {
  return messages.map((m) => ({
    id: m.id,
    timestamp: m.timestamp,
    direction: m.error ? 'error' : DIRECTION[m.direction],
    label: m.topic,
    body: m.error ?? m.payload,
  }));
}
