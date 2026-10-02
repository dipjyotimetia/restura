import type { WebSocketMessage } from '@/features/websocket/store/useWebSocketStore';
import type { LogEntry } from '@/lib/shared/messageLog';

const DIRECTION = { sent: 'out', received: 'in', system: 'system' } as const;

/** Export file base name derived from the socket URL's host. */
export function wsExportName(url: string): string {
  try {
    return `${new URL(url).hostname}-websocket`;
  } catch {
    return 'websocket-messages';
  }
}

/** WebSocket messages in the shared message-log shape (for export). */
export function wsToLogEntries(messages: readonly WebSocketMessage[]): LogEntry[] {
  return messages.map((m) => ({
    id: m.id,
    timestamp: m.timestamp,
    direction: DIRECTION[m.type],
    label: m.type === 'system' ? undefined : m.dataType,
    body: m.content,
  }));
}
