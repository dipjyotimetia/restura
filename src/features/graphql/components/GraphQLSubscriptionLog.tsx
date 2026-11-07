import { useMemo, useState } from 'react';
import {
  MessageLogToolbar,
  useFrozenView,
} from '@/components/shared/messageLog/MessageLogControls';
import { filteredEmptyText, filterLog, type LogDirection } from '@/lib/shared/messageLog';
import { cn } from '@/lib/shared/utils';
import type { SubscriptionLogMessage } from '../lib/subscriptionLog';

const DIRECTIONS: ReadonlyArray<LogDirection> = ['in', 'error', 'system'];

const directionOf = (type: SubscriptionLogMessage['type']): LogDirection =>
  type === 'data' ? 'in' : type === 'error' ? 'error' : 'system';

/**
 * The subscription Messages tab's log: the shared search / direction filter /
 * freeze / export / clear toolbar over the received events.
 */
export function GraphQLSubscriptionLog({
  messages,
  isSubscribed,
  exportName,
  exportMeta,
  onClear,
}: {
  messages: SubscriptionLogMessage[];
  isSubscribed: boolean;
  exportName: string;
  exportMeta?: Record<string, unknown>;
  onClear: () => void;
}) {
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState<LogDirection | 'all'>('all');
  const [frozen, setFrozen] = useState(false);
  const entries = useMemo(
    () =>
      messages.map((msg) => ({
        ...msg,
        direction: directionOf(msg.type),
        label: msg.protocol ? `${msg.type} · ${msg.protocol}` : msg.type,
        body: msg.payloadText ?? msg.error ?? '',
      })),
    [messages]
  );
  const filtered = useMemo(
    () => filterLog(entries, { query, direction }),
    [entries, query, direction]
  );
  const { visible, newCount } = useFrozenView(filtered, frozen);

  return (
    <>
      <div className="-mx-3 mb-2">
        <MessageLogToolbar
          query={query}
          onQueryChange={setQuery}
          direction={direction}
          onDirectionChange={setDirection}
          directions={DIRECTIONS}
          frozen={frozen}
          newCount={newCount}
          onFrozenChange={setFrozen}
          exportEntries={() => filtered}
          exportName={exportName}
          {...(exportMeta ? { exportMeta } : {})}
          onClear={onClear}
          hasEntries={messages.length > 0}
        />
      </div>
      {messages.length > 0 && visible.length === 0 ? (
        <div className="text-center py-8 text-sp-muted font-mono text-sp-12">
          {filteredEmptyText('message', newCount)}
        </div>
      ) : messages.length === 0 ? (
        <div className="text-center py-8 text-sp-muted font-mono text-sp-12">
          {isSubscribed ? 'Waiting for messages...' : 'Click Subscribe to start receiving events.'}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'p-2 rounded-sp-btn border text-sp-11 font-mono',
                msg.type === 'data'
                  ? 'bg-emerald-500/5 border-emerald-500/20'
                  : msg.type === 'error'
                    ? 'bg-destructive/5 border-destructive/20'
                    : msg.type === 'connected'
                      ? 'bg-blue-500/5 border-blue-500/20'
                      : 'bg-sp-surface-lo border-sp-line'
              )}
            >
              <div className="flex items-center gap-2 mb-1 sp-label">
                <span>{msg.type}</span>
                {msg.protocol && <span>{msg.protocol}</span>}
                <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
              </div>
              {msg.payload !== undefined && (
                <pre className="whitespace-pre-wrap break-all">{msg.payloadText}</pre>
              )}
              {msg.error && <span className="text-destructive">{msg.error}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
