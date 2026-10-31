import { Trash2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { McpNotificationEntry } from '@/features/mcp/lib/mcpNotifications';

interface McpNotificationsPanelProps {
  entries: McpNotificationEntry[];
  onClear: () => void;
}

const KIND_LABEL: Record<McpNotificationEntry['kind'], string> = {
  progress: 'PROGRESS',
  log: 'LOG',
  list_changed: 'LIST',
  resource_updated: 'UPDATED',
  subscription_closed: 'UNSUB',
  error: 'ERROR',
  close: 'CLOSED',
  other: 'NOTIFY',
};

function kindColor(entry: McpNotificationEntry): string {
  switch (entry.kind) {
    case 'error':
    case 'close':
      return 'var(--color-danger)';
    case 'subscription_closed':
      return 'var(--color-warning)';
    case 'log':
      return entry.level === 'error' ||
        entry.level === 'critical' ||
        entry.level === 'alert' ||
        entry.level === 'emergency'
        ? 'var(--color-danger)'
        : entry.level === 'warning'
          ? 'var(--color-warning)'
          : 'var(--color-neutral)';
    case 'resource_updated':
    case 'list_changed':
      return 'var(--color-success)';
    default:
      return 'var(--color-neutral)';
  }
}

function ProgressBar({ progress }: { progress: NonNullable<McpNotificationEntry['progress']> }) {
  const { value, total } = progress;
  const pct = total && total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : undefined;
  return (
    <div className="mt-1 flex items-center gap-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total ?? undefined}
        aria-valuenow={value}
        className="h-1.5 flex-1 rounded-full bg-sp-hover overflow-hidden"
      >
        <div
          className="h-full rounded-full"
          style={{
            width: pct !== undefined ? `${pct}%` : '100%',
            background: 'var(--sp-accent)',
            opacity: pct !== undefined ? 1 : 0.4,
          }}
        />
      </div>
      <span className="text-sp-11 text-sp-dim font-mono tabular-nums shrink-0">
        {total !== undefined ? `${value}/${total}` : value}
      </span>
    </div>
  );
}

/**
 * Server→client MCP events for the live session (#858): progress for
 * in-flight calls, server log lines, list_changed, resources/updated, and
 * connection errors/closure. Newest first; the store bounds the buffer.
 */
export function McpNotificationsPanel({ entries, onClear }: McpNotificationsPanelProps) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 h-9 border-b border-sp-line shrink-0">
        <span className="sp-label">{entries.length} EVENTS</span>
        <button
          type="button"
          onClick={onClear}
          disabled={entries.length === 0}
          className="inline-flex items-center gap-1 text-sp-11 text-sp-muted hover:text-sp-text disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" /> Clear
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="flex-1 grid place-items-center px-4">
          <div className="text-center">
            <div className="font-mono text-sp-12 text-sp-muted">No server events</div>
            <div className="mt-1 text-sp-11-5 text-sp-dim">
              Progress, log messages, list changes and resource updates appear here.
            </div>
          </div>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <ul className="p-2 space-y-1" aria-label="MCP server events">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-sp-btn border border-sp-line bg-sp-surface-lo px-2.5 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="font-mono text-sp-11 font-bold shrink-0"
                    style={{ color: kindColor(entry) }}
                  >
                    {entry.kind === 'log' && entry.level
                      ? entry.level.toUpperCase()
                      : KIND_LABEL[entry.kind]}
                  </span>
                  <span className="text-sp-11 text-sp-dim font-mono tabular-nums">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="mt-0.5 text-sp-11-5 text-sp-text break-words">{entry.summary}</div>
                {entry.progress && <ProgressBar progress={entry.progress} />}
                {entry.detail && (
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-sp-11 text-sp-muted">
                    {entry.detail}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
