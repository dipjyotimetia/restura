import { RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CodeEditorFrame, ConnectionBadge, Floater, Stat } from '@/components/ui/spatial';
import { TabsContent } from '@/components/ui/tabs';
import type { KafkaMessage } from '@/features/kafka/store/useKafkaStore';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { useRapidAppendFlag } from '@/lib/shared/useRapidAppendFlag';
import { cn } from '@/lib/shared/utils';
import type { KafkaConnection } from '../store/useKafkaStore';
import { KAFKA_PINK, partitionColor } from './shared';

function PartitionPill({ partition, count }: { partition: number; count?: number }) {
  const color = partitionColor(partition);
  return (
    <span
      className="inline-flex items-center gap-1.5 h-6 px-2 font-mono font-bold text-sp-11 tabular-nums rounded-sp-chip"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
      }}
    >
      <span>P{partition}</span>
      {count !== undefined && (
        <span className="font-normal opacity-80">{count.toLocaleString()}</span>
      )}
    </span>
  );
}

function PartitionMiniPill({ partition }: { partition: number }) {
  const color = partitionColor(partition);
  return (
    <span
      className="inline-flex items-center justify-center h-5 w-8 font-mono font-bold text-sp-9 rounded-sp-chip"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
      }}
    >
      P{partition}
    </span>
  );
}

function tryFormatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** The receive log and selected-message inspector, scoped to one connection. */
export function KafkaMessagesPanel({
  connection,
  paused,
}: {
  connection: KafkaConnection;
  paused: boolean;
}) {
  const messageFilter = useKafkaStore((state) => state.messageFilter);
  const searchQuery = useKafkaStore((state) => state.searchQuery);
  const clearMessages = useKafkaStore((state) => state.clearMessages);
  const setMessageFilter = useKafkaStore((state) => state.setMessageFilter);
  const setSearchQuery = useKafkaStore((state) => state.setSearchQuery);
  const getFilteredMessages = useKafkaStore((state) => state.getFilteredMessages);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [pausedSnapshot, setPausedSnapshot] = useState<KafkaMessage[] | null>(null);

  const filteredMessages = useMemo(
    () => getFilteredMessages(connection.id),
    [connection.id, connection.messages, getFilteredMessages, messageFilter, searchQuery]
  );
  const partitionCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const message of connection.messages) {
      if (message.partition !== undefined) {
        counts.set(message.partition, (counts.get(message.partition) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort(([left], [right]) => left - right)
      .map(([partition, count]) => ({ partition, count }));
  }, [connection.messages]);
  const msgPerSec = useMemo(() => {
    const cutoff = Date.now() - 5_000;
    const recent = connection.messages.filter(
      (message) => message.direction === 'received' && message.timestamp >= cutoff
    );
    return Math.round((recent.length / 5) * 10) / 10;
  }, [connection.messages]);
  const selectedMessage = useMemo(
    () => connection.messages.find((message) => message.id === selectedMessageId) ?? null,
    [connection.messages, selectedMessageId]
  );
  const rapidStream = useRapidAppendFlag(connection.messages.length);

  useEffect(() => {
    setSelectedMessageId(null);
    setPausedSnapshot(null);
  }, [connection.id]);
  useEffect(() => {
    setPausedSnapshot(paused ? filteredMessages : null);
  }, [paused]);

  const visibleMessages = paused && pausedSnapshot ? pausedSnapshot : filteredMessages;

  return (
    <TabsContent value="messages" className="flex-1 flex flex-col min-h-0 gap-3 m-0">
      <Floater
        radius="panel"
        className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3 shrink-0"
      >
        <Stat label="Partitions" value={partitionCounts.length || '—'} />
        <Stat label="Consumer ID" value={connection.consumer.groupId || '—'} />
        <Stat
          label="Lag"
          value={
            <span
              style={{
                color:
                  partitionCounts.length === 0 ? 'var(--color-success)' : 'var(--color-warning)',
              }}
            >
              {connection.consumer.status === 'subscribed' ? '—' : '0'}
            </span>
          }
        />
        <Stat
          label="Offset Reset"
          value={connection.consumer.fromBeginning ? 'earliest' : 'latest'}
        />
        <Stat label="Msg/Sec" value={msgPerSec.toFixed(1)} />
        {partitionCounts.length > 0 && (
          <>
            <span className="h-7 w-px bg-sp-line" />
            <div className="flex flex-wrap items-center gap-1.5">
              {partitionCounts.map(({ partition, count }) => (
                <PartitionPill key={partition} partition={partition} count={count} />
              ))}
            </div>
          </>
        )}
      </Floater>
      <div className="flex-1 min-h-0 grid gap-2.5" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <Floater radius="panel" className="flex flex-col min-h-0 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-sp-line shrink-0">
            <Select
              value={messageFilter}
              onValueChange={(value) =>
                setMessageFilter(value as 'sent' | 'received' | 'system' | 'all')
              }
            >
              <SelectTrigger className="h-7 w-28 text-xs bg-sp-surface-lo border border-sp-line">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="received">Received</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-sp-dim" />
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search topic, key, value"
                className="h-7 pl-7 text-xs bg-sp-surface-lo border-sp-line font-mono"
              />
            </div>
            {paused && <ConnectionBadge label="Paused" tone="warning" />}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => clearMessages(connection.id)}
              className="h-7 w-7 p-0"
              title="Clear messages"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div
            className="grid items-center gap-2 px-3 py-1.5 border-b border-sp-line shrink-0"
            style={{ gridTemplateColumns: '40px 80px 110px 130px 1fr' }}
          >
            <span className="sp-label">Part</span>
            <span className="sp-label">Offset</span>
            <span className="sp-label">Time</span>
            <span className="sp-label">Key</span>
            <span className="sp-label">Value</span>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <ul className="text-xs" data-stream-rapid={rapidStream || undefined}>
              {visibleMessages.map((message) => {
                const selected = message.id === selectedMessageId;
                return (
                  <li
                    key={message.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedMessageId(message.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedMessageId(message.id);
                      }
                    }}
                    className={cn(
                      'grid items-center gap-2 px-3 py-1.5 cursor-pointer font-mono border-l-2 transition-colors sp-stream-row',
                      selected
                        ? 'bg-sp-active border-l-sp-accent'
                        : 'border-l-transparent hover:bg-sp-hover'
                    )}
                    style={{ gridTemplateColumns: '40px 80px 110px 130px 1fr' }}
                  >
                    <div>
                      {message.partition !== undefined ? (
                        <PartitionMiniPill partition={message.partition} />
                      ) : (
                        <span className="text-sp-dim">—</span>
                      )}
                    </div>
                    <span className="text-sp-muted tabular-nums truncate">
                      {message.offset ?? '—'}
                    </span>
                    <span className="text-sp-dim tabular-nums">
                      {new Date(message.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="text-sp-muted truncate" title={message.key ?? ''}>
                      {message.key ?? <span className="text-sp-dim">—</span>}
                    </span>
                    <span
                      className={cn('truncate', message.error ? 'text-red-400' : 'text-sp-text')}
                      title={message.value}
                    >
                      {message.error ? message.error : message.value}
                    </span>
                  </li>
                );
              })}
              {visibleMessages.length === 0 && (
                <li className="px-3 py-8 text-center text-sp-muted">No messages yet.</li>
              )}
            </ul>
          </ScrollArea>
        </Floater>
        <Floater radius="panel" className="flex flex-col min-h-0 overflow-hidden">
          {selectedMessage ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-sp-line shrink-0">
                <span className="sp-label">Message</span>
                <span className="text-sp-dim font-mono">·</span>
                {selectedMessage.partition !== undefined && (
                  <PartitionMiniPill partition={selectedMessage.partition} />
                )}
                <span className="font-mono text-sp-12 text-sp-muted tabular-nums">
                  {selectedMessage.offset ?? '—'}
                </span>
                <span className="ml-auto font-mono text-sp-11 text-sp-dim">
                  {new Date(selectedMessage.timestamp).toLocaleString()}
                </span>
              </div>
              <ScrollArea className="flex-1 min-h-0">
                <div className="p-3 space-y-3">
                  {selectedMessage.topic && (
                    <div className="space-y-1">
                      <div className="sp-label">Topic</div>
                      <div className="font-mono text-sp-12" style={{ color: KAFKA_PINK }}>
                        {selectedMessage.topic}
                      </div>
                    </div>
                  )}
                  {selectedMessage.key && (
                    <div className="space-y-1">
                      <div className="sp-label">
                        Key{selectedMessage.keyEncoding === 'base64' ? ' · Base64' : ''}
                      </div>
                      <div className="font-mono text-sp-12 text-sp-text break-all">
                        {selectedMessage.key}
                      </div>
                    </div>
                  )}
                  <div className="space-y-1">
                    <div className="sp-label">Headers</div>
                    {selectedMessage.headers && Object.keys(selectedMessage.headers).length > 0 ? (
                      <div
                        className="grid gap-x-3 gap-y-1 font-mono text-sp-11-5"
                        style={{ gridTemplateColumns: 'auto 1fr' }}
                      >
                        {Object.entries(selectedMessage.headers).map(([key, value]) => (
                          <div key={key} className="contents">
                            <span className="text-sp-muted">{key}</span>
                            <span className="text-sp-text break-all">{value}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sp-dim text-sp-11-5 italic">No headers</div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="sp-label">
                      Value{selectedMessage.valueEncoding === 'base64' ? ' · Base64' : ''}
                    </div>
                    {(() => {
                      const formatted = tryFormatJson(selectedMessage.value);
                      return (
                        <CodeEditorFrame lineCount={formatted.split('\n').length}>
                          <pre className="whitespace-pre-wrap break-all text-sp-text">
                            {formatted}
                          </pre>
                        </CodeEditorFrame>
                      );
                    })()}
                  </div>
                  {selectedMessage.error && (
                    <div className="space-y-1">
                      <div className="sp-label">Error</div>
                      <div className="font-mono text-sp-12 text-red-400 break-all">
                        {selectedMessage.error}
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-sp-muted">
              Select a message to inspect.
            </div>
          )}
        </Floater>
      </div>
    </TabsContent>
  );
}
