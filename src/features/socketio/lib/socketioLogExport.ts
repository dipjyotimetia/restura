import type { SocketIOEvent } from '@/features/socketio/store/useSocketIOStore';
import type { LogEntry } from '@/lib/shared/messageLog';

const DIRECTION = { sent: 'out', received: 'in', system: 'system', ack: 'in' } as const;

/** Export file base name derived from the server URL's host. */
export function socketioExportName(url: string): string {
  try {
    return `${new URL(url).hostname}-socketio`;
  } catch {
    return 'socketio-events';
  }
}

/** Socket.IO events in the shared message-log shape (for export). */
export function socketioToLogEntries(events: readonly SocketIOEvent[]): LogEntry[] {
  return events.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    direction: DIRECTION[e.direction],
    label: e.direction === 'ack' ? `${e.eventName} (ack ${e.ackStatus ?? 'ok'})` : e.eventName,
    body: JSON.stringify(e.args),
  }));
}
