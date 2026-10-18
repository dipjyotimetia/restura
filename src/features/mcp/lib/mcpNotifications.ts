/**
 * Pure classification of server→client MCP events (#858) into bounded,
 * display-ready entries for the notifications pane. Raw params are reduced to
 * a truncated `detail` string so a chatty server can't grow memory without
 * bound (the store also caps the entry count).
 */

export type McpListKind = 'tools' | 'resources' | 'prompts';

export type McpNotificationKind =
  | 'progress'
  | 'log'
  | 'list_changed'
  | 'resource_updated'
  | 'subscription_closed'
  | 'error'
  | 'close'
  | 'other';

export interface McpNotificationEntry {
  id: string;
  timestamp: number;
  kind: McpNotificationKind;
  method: string;
  /** One-line human summary. */
  summary: string;
  /** Truncated JSON of the params (log data, extra fields). */
  detail?: string;
  /** Logging level for `notifications/message`. */
  level?: string;
  /** Present for `progress` entries; `progressKey` groups updates of one call. */
  progress?: { key: string; value: number; total?: number; message?: string };
  listKind?: McpListKind;
  uri?: string;
}

export type McpNotificationDraft = Omit<McpNotificationEntry, 'id' | 'timestamp'>;

/** Synthetic method the desktop main process emits when a server ends a listen stream. */
export const MCP_SUBSCRIPTION_CLOSED_METHOD = 'restura/subscriptionClosed';

export const MAX_NOTIFICATION_DETAIL = 2_000;

const LIST_CHANGED: Record<string, McpListKind> = {
  'notifications/tools/list_changed': 'tools',
  'notifications/resources/list_changed': 'resources',
  'notifications/prompts/list_changed': 'prompts',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** JSON-stringify (dropping the SDK's `_meta` envelope) and truncate. */
export function truncateDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text =
      typeof value === 'string'
        ? value
        : JSON.stringify(value, (key, v) => (key === '_meta' ? undefined : v));
  } catch {
    text = String(value);
  }
  if (text === undefined || text === '{}') return undefined;
  return text.length > MAX_NOTIFICATION_DETAIL
    ? `${text.slice(0, MAX_NOTIFICATION_DETAIL)}… (${text.length - MAX_NOTIFICATION_DETAIL} more chars)`
    : text;
}

/** Classify one `mcp:notification` payload. Returns null for non-notification junk. */
export function classifyMcpNotification(raw: unknown): McpNotificationDraft | null {
  const message = asRecord(raw);
  const method = str(message.method);
  if (!method) return null;
  const params = asRecord(message.params);

  const listKind = LIST_CHANGED[method];
  if (listKind) {
    return { kind: 'list_changed', method, listKind, summary: `${listKind} list changed` };
  }

  switch (method) {
    case 'notifications/progress': {
      const value = num(params.progress) ?? 0;
      const total = num(params.total);
      const progressMessage = str(params.message);
      const name = str(params.name);
      const requestMethod = str(params.requestMethod);
      const key =
        str(params.progressKey) ??
        (params.progressToken !== undefined ? String(params.progressToken) : method);
      const target = name ?? requestMethod ?? 'request';
      return {
        kind: 'progress',
        method,
        summary: progressMessage ? `${target}: ${progressMessage}` : target,
        progress: {
          key,
          value,
          ...(total !== undefined ? { total } : {}),
          ...(progressMessage ? { message: progressMessage } : {}),
        },
      };
    }
    case 'notifications/message': {
      const level = str(params.level) ?? 'info';
      const logger = str(params.logger);
      const data = params.data;
      const text = typeof data === 'string' ? data : truncateDetail(data);
      return {
        kind: 'log',
        method,
        level,
        summary: `${logger ? `[${logger}] ` : ''}${text ?? '(no data)'}`.slice(0, 200),
        ...(typeof data === 'string' ? {} : { detail: truncateDetail(data) }),
      };
    }
    case 'notifications/resources/updated': {
      const uri = str(params.uri) ?? '(unknown uri)';
      return { kind: 'resource_updated', method, uri, summary: `${uri} updated` };
    }
    case MCP_SUBSCRIPTION_CLOSED_METHOD: {
      const uri = str(params.uri);
      const reason = str(params.reason) ?? 'remote';
      return {
        kind: 'subscription_closed',
        method,
        ...(uri ? { uri } : {}),
        summary: uri
          ? `Server ended the subscription to ${uri} (${reason})`
          : `Server ended the list-change stream (${reason})`,
      };
    }
    default:
      return {
        kind: 'other',
        method,
        summary: method,
        ...(Object.keys(params).length > 0 ? { detail: truncateDetail(params) } : {}),
      };
  }
}

export function errorEntry(message: string): McpNotificationDraft {
  return { kind: 'error', method: 'mcp:error', summary: message.slice(0, 500) };
}

export function closeEntry(reason: string): McpNotificationDraft {
  return { kind: 'close', method: 'mcp:close', summary: `Connection closed: ${reason}` };
}
