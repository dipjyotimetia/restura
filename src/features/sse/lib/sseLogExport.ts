import type { SseLogEntry } from '@/features/sse/store/useSseStore';
import type { LogEntry } from '@/lib/shared/messageLog';

/** Export file base name derived from the stream URL's host. */
export function sseExportName(url: string): string {
  try {
    return `${new URL(url).hostname}-sse`;
  } catch {
    return 'sse-stream';
  }
}

/** SSE log entries in the shared message-log shape (for export). */
export function sseToLogEntries(log: readonly SseLogEntry[]): LogEntry[] {
  return log.map((e) =>
    e.kind === 'system'
      ? { id: e.id, timestamp: e.timestamp, direction: 'system', body: e.message }
      : { id: e.id, timestamp: e.timestamp, direction: 'in', label: e.event, body: e.data }
  );
}
