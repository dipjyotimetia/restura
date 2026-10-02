/**
 * Shared logic for the streaming message logs (WebSocket, Socket.IO, SSE,
 * gRPC streams, MQTT, Kafka). Each protocol maps its own messages to
 * `LogEntry`; filtering, export and freeze accounting live here once.
 */

export type LogDirection = 'in' | 'out' | 'system' | 'error';

export interface LogEntry {
  id: string;
  timestamp: number;
  direction: LogDirection;
  /** Event name, topic, method… whatever names the message in this protocol. */
  label?: string;
  /** Payload as text. */
  body: string;
}

export interface LogFilter {
  query: string;
  direction: LogDirection | 'all';
}

/** Entries matching the direction and a case-insensitive search of label and body. */
export function filterLog<T extends LogEntry>(entries: readonly T[], filter: LogFilter): T[] {
  const q = filter.query.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (filter.direction === 'all' || e.direction === filter.direction) &&
      (!q || e.body.toLowerCase().includes(q) || (e.label?.toLowerCase().includes(q) ?? false))
  );
}

/**
 * Export entries as a pretty JSON document (with a small header) or as
 * NDJSON (one entry per line, for jq / log tools). JSON payloads are
 * embedded as values, not strings, so the export stays queryable.
 */
export function exportLog(
  entries: readonly LogEntry[],
  format: 'json' | 'ndjson',
  meta: Record<string, unknown> = {}
): string {
  const rows = entries.map((e) => ({
    timestamp: new Date(e.timestamp).toISOString(),
    direction: e.direction,
    ...(e.label !== undefined ? { label: e.label } : {}),
    payload: parseMaybeJson(e.body),
  }));
  if (format === 'ndjson') return rows.map((r) => JSON.stringify(r)).join('\n');
  return JSON.stringify(
    { ...meta, exportedAt: new Date().toISOString(), count: rows.length, messages: rows },
    null,
    2
  );
}

function parseMaybeJson(body: string): unknown {
  const t = body.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Empty-state text when a filtered log shows nothing: says so when the only
 * matches arrived after a freeze, rather than blaming the filter.
 */
export function filteredEmptyText(noun: 'message' | 'event', newCount: number): string {
  if (newCount > 0) {
    return `Frozen — ${newCount} new ${noun}${newCount === 1 ? '' : 's'} since. Resume to show ${newCount === 1 ? 'it' : 'them'}.`;
  }
  return `No ${noun}s match the current filter.`;
}

/**
 * Split a log at a freeze cutoff: `visible` is what had arrived by `cutoff`
 * (ms epoch, local receipt time), `newCount` is what arrived after. A null
 * cutoff means live — everything is visible.
 */
export function splitAtCutoff<T extends { timestamp: number }>(
  entries: readonly T[],
  cutoff: number | null
): { visible: T[]; newCount: number } {
  if (cutoff === null) return { visible: entries as T[], newCount: 0 };
  const visible = entries.filter((e) => e.timestamp <= cutoff);
  return { visible, newCount: entries.length - visible.length };
}
