import { RefreshCw, Search } from 'lucide-react';
import { memo } from 'react';
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
import type {
  MqttConnection,
  MqttMessage,
  MqttMessageDirection,
} from '@/features/mqtt/store/useMqttStore';
import { cn } from '@/lib/shared/utils';
import { MQTT_GREEN, QosPill } from './mqttUi';

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/**
 * One row in the message log. Memoized so a high-throughput batch only renders
 * the newly-arrived rows — the MQTT store preserves object identity for existing
 * messages, and MqttClient provides a stable selection callback.
 */
const MessageRow = memo(function MessageRow({
  message,
  selected,
  onSelect,
}: {
  message: MqttMessage;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={() => onSelect(message.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(message.id);
        }
      }}
      className={cn(
        'grid items-center gap-2 px-3 py-1.5 cursor-pointer font-mono border-l-2 transition-colors sp-stream-row',
        selected ? 'bg-sp-active border-l-sp-accent' : 'border-l-transparent hover:bg-sp-hover'
      )}
      style={{ gridTemplateColumns: '40px 50px 110px 1fr' }}
    >
      <div>
        <QosPill qos={message.qos} />
      </div>
      <span className="text-sp-dim">
        {message.retain ? <span style={{ color: MQTT_GREEN }}>R</span> : '—'}
      </span>
      <span className="text-sp-dim tabular-nums">
        {new Date(message.timestamp).toLocaleTimeString()}
      </span>
      <span className="truncate">
        {message.topic && (
          <span style={{ color: MQTT_GREEN }} className="mr-2">
            {message.topic}
          </span>
        )}
        <span
          className={cn(message.error ? 'text-red-400' : 'text-sp-text')}
          title={message.payload}
        >
          {message.error ? message.error : message.payload}
        </span>
      </span>
    </li>
  );
});

interface MqttMessagesPanelProps {
  connection: MqttConnection;
  messageFilter: MqttMessageDirection | 'all';
  msgPerSec: number;
  onClearMessages: () => void;
  onMessageFilterChange: (filter: MqttMessageDirection | 'all') => void;
  onSearchQueryChange: (query: string) => void;
  onSelectMessage: (id: string) => void;
  paused: boolean;
  rapidStream: boolean;
  searchQuery: string;
  selectedMessage: MqttMessage | null;
  selectedMessageId: string | null;
  visibleMessages: MqttMessage[];
}

/** Message stream controls and detail panel, isolated from connection lifecycle state. */
export function MqttMessagesPanel({
  connection,
  messageFilter,
  msgPerSec,
  onClearMessages,
  onMessageFilterChange,
  onSearchQueryChange,
  onSelectMessage,
  paused,
  rapidStream,
  searchQuery,
  selectedMessage,
  selectedMessageId,
  visibleMessages,
}: MqttMessagesPanelProps) {
  return (
    <TabsContent value="messages" className="flex-1 flex flex-col min-h-0 gap-3 m-0">
      <Floater
        radius="panel"
        className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3 shrink-0"
      >
        <Stat label="Subscriptions" value={connection.subscriptions.length || '—'} />
        <Stat label="Client ID" value={connection.clientId || '—'} />
        <Stat label="Messages" value={connection.messages.length} />
        <Stat label="Msg/Sec" value={msgPerSec.toFixed(1)} />
        <Stat label="Keepalive" value={`${connection.keepalive}s`} />
      </Floater>

      <div className="flex-1 min-h-0 grid gap-2.5" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <Floater radius="panel" className="flex flex-col min-h-0 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-sp-line shrink-0">
            <Select
              value={messageFilter}
              onValueChange={(filter) =>
                onMessageFilterChange(filter as MqttMessageDirection | 'all')
              }
            >
              <SelectTrigger className="h-7 w-28 text-xs bg-sp-surface-lo border border-sp-line">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="sent">Published</SelectItem>
                <SelectItem value="received">Received</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-sp-dim" />
              <Input
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                placeholder="Search topic, payload"
                className="h-7 pl-7 text-xs bg-sp-surface-lo border-sp-line font-mono"
              />
            </div>
            {paused && <ConnectionBadge label="Paused" tone="warning" />}
            <Button
              size="sm"
              variant="ghost"
              onClick={onClearMessages}
              className="h-7 w-7 p-0"
              title="Clear messages"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div
            className="grid items-center gap-2 px-3 py-1.5 border-b border-sp-line shrink-0"
            style={{ gridTemplateColumns: '40px 50px 110px 1fr' }}
          >
            <span className="sp-label">QoS</span>
            <span className="sp-label">Ret</span>
            <span className="sp-label">Time</span>
            <span className="sp-label">Topic / Payload</span>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <ul className="text-xs" data-stream-rapid={rapidStream || undefined}>
              {visibleMessages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  selected={message.id === selectedMessageId}
                  onSelect={onSelectMessage}
                />
              ))}
              {visibleMessages.length === 0 && (
                <li className="px-3 py-8 text-center text-sp-muted">No messages yet.</li>
              )}
            </ul>
          </ScrollArea>
        </Floater>

        <MessageDetail message={selectedMessage} />
      </div>
    </TabsContent>
  );
}

function MessageDetail({ message }: { message: MqttMessage | null }) {
  if (!message) {
    return (
      <Floater radius="panel" className="flex flex-col min-h-0 overflow-hidden">
        <div className="flex flex-1 items-center justify-center text-sm text-sp-muted">
          Select a message to inspect.
        </div>
      </Floater>
    );
  }

  const metadata: Array<[string, string]> = [];
  if (message.responseTopic) metadata.push(['Response topic', message.responseTopic]);
  if (message.correlationData) metadata.push(['Correlation data', message.correlationData]);
  if (message.contentType) metadata.push(['Content type', message.contentType]);
  if (message.subscriptionIdentifier !== undefined) {
    const ids = message.subscriptionIdentifier;
    metadata.push(['Subscription id', Array.isArray(ids) ? ids.join(', ') : String(ids)]);
  }
  const formattedPayload = formatJson(message.payload);

  return (
    <Floater radius="panel" className="flex flex-col min-h-0 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-sp-line shrink-0">
        <span className="sp-label">Message</span>
        <QosPill qos={message.qos} />
        {message.retain && (
          <span className="font-mono text-sp-11" style={{ color: MQTT_GREEN }}>
            retained
          </span>
        )}
        <span className="ml-auto font-mono text-sp-11 text-sp-dim">
          {new Date(message.timestamp).toLocaleString()}
        </span>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {message.topic && (
            <div className="space-y-1">
              <div className="sp-label">Topic</div>
              <div className="font-mono text-sp-12" style={{ color: MQTT_GREEN }}>
                {message.topic}
              </div>
            </div>
          )}

          {message.userProperties && Object.keys(message.userProperties).length > 0 && (
            <MetadataGrid
              label="User properties (v5)"
              entries={Object.entries(message.userProperties).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(', ') : value,
              ])}
            />
          )}

          {metadata.length > 0 && <MetadataGrid label="MQTT 5 metadata" entries={metadata} />}

          <div className="space-y-1">
            <div className="sp-label">Payload</div>
            <CodeEditorFrame lineCount={formattedPayload.split('\n').length}>
              <pre className="whitespace-pre-wrap break-all text-sp-text">{formattedPayload}</pre>
            </CodeEditorFrame>
          </div>

          {message.error && (
            <div className="space-y-1">
              <div className="sp-label">Error</div>
              <div className="font-mono text-sp-12 text-red-400 break-all">{message.error}</div>
            </div>
          )}
        </div>
      </ScrollArea>
    </Floater>
  );
}

function MetadataGrid({ label, entries }: { label: string; entries: Array<[string, string]> }) {
  return (
    <div className="space-y-1">
      <div className="sp-label">{label}</div>
      <div
        className="grid gap-x-3 gap-y-1 font-mono text-sp-11-5"
        style={{ gridTemplateColumns: 'auto 1fr' }}
      >
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
            <span className="text-sp-muted">{key}</span>
            <span className="text-sp-text break-all">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
