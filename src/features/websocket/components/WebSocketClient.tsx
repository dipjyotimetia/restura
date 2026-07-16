import { Download, Filter, Search, Send, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CodeEditorFrame,
  CountToggle,
  Floater,
  Kbd,
  ProtoChip,
  Segmented,
  Stat,
  TextField,
  ToggleField,
  VariableText,
} from '@/components/ui/spatial';
import { websocketManager } from '@/features/websocket/lib/websocketManager';
import type { WebSocketMessageType } from '@/features/websocket/store/useWebSocketStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { useRapidAppendFlag } from '@/lib/shared/useRapidAppendFlag';
import { cn, keyValuePairsToRecord } from '@/lib/shared/utils';
import { useActiveTabId } from '@/store/selectors';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

type SendFormat = 'json' | 'text' | 'binary';

const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
};

const formatSize = (content: string): string => {
  const bytes = new Blob([content]).size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function previewContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed;
}

function tryPrettyJson(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

function DirTag({ type }: { type: WebSocketMessageType }) {
  if (type === 'sent') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sp-chip px-1.5 h-5 font-mono font-bold text-sp-9 tracking-wide"
        style={{
          color: 'var(--color-proto-ws)',
          background: 'color-mix(in srgb, var(--color-proto-ws) 16%, transparent)',
        }}
      >
        → tx
      </span>
    );
  }
  if (type === 'received') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sp-chip px-1.5 h-5 font-mono font-bold text-sp-9 tracking-wide"
        style={{
          color: 'var(--color-success)',
          background: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
        }}
      >
        ← rx
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sp-chip px-1.5 h-5 font-mono font-bold text-sp-9 tracking-wide"
      style={{
        color: 'var(--color-warning)',
        background: 'color-mix(in srgb, var(--color-warning) 16%, transparent)',
      }}
    >
      sys
    </span>
  );
}

function UptimeStat({ connectedAt, isConnected }: { connectedAt?: number; isConnected: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isConnected) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [isConnected]);
  const duration = isConnected && connectedAt ? now - connectedAt : 0;
  return <Stat label="Uptime" value={duration > 0 ? formatDuration(duration) : '—'} />;
}

function WebSocketClient() {
  const [message, setMessage] = useState('');
  const [sendFormat, setSendFormat] = useState<SendFormat>('json');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  // null = auto (open only when something is configured); boolean = user override.
  const [configOpenOverride, setConfigOpenOverride] = useState<boolean | null>(null);

  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);
  const activeTabId = useActiveTabId();

  const connectionByTabId = useWebSocketStore((s) => s.connectionByTabId);
  const messageFilter = useWebSocketStore((s) => s.messageFilter);
  const searchQuery = useWebSocketStore((s) => s.searchQuery);
  const activeConnectionId = activeTabId ? (connectionByTabId[activeTabId] ?? null) : null;
  const connection = useWebSocketStore((s) =>
    activeConnectionId ? (s.connections[activeConnectionId] ?? null) : null
  );
  const {
    ensureConnectionForTab,
    updateConnectionUrl,
    setAutoReconnect,
    clearMessages,
    setMessageFilter,
    setSearchQuery,
    getFilteredMessages,
    addMessage,
    addHeader,
    updateHeader,
    removeHeader,
    setProtocols,
  } = useWebSocketStore(
    useShallow((s) => ({
      ensureConnectionForTab: s.ensureConnectionForTab,
      updateConnectionUrl: s.updateConnectionUrl,
      setAutoReconnect: s.setAutoReconnect,
      clearMessages: s.clearMessages,
      setMessageFilter: s.setMessageFilter,
      setSearchQuery: s.setSearchQuery,
      getFilteredMessages: s.getFilteredMessages,
      addMessage: s.addMessage,
      addHeader: s.addHeader,
      updateHeader: s.updateHeader,
      removeHeader: s.removeHeader,
      setProtocols: s.setProtocols,
    }))
  );

  useEffect(() => {
    if (activeTabId) ensureConnectionForTab(activeTabId);
  }, [activeTabId, ensureConnectionForTab]);

  // Counts (memoised so we don't walk the full message list on every render).
  const counts = useMemo(() => {
    if (!connection) return { sent: 0, received: 0 };
    let sent = 0;
    let received = 0;
    for (const m of connection.messages) {
      if (m.type === 'sent') sent++;
      else if (m.type === 'received') received++;
    }
    return { sent, received };
  }, [connection]);

  // Suppresses per-row entry animation while messages arrive faster than ~10/s.
  // Must sit above the early return below (rules of hooks).
  const rapidStream = useRapidAppendFlag(connection?.messages.length ?? 0);

  if (!connection || !activeConnectionId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-transparent">
        <p className="text-sp-12 text-sp-dim font-mono">Preparing WebSocket connection…</p>
      </div>
    );
  }

  const isConnected = connection.status === 'connected';
  const isConnecting = connection.status === 'connecting' || connection.status === 'reconnecting';
  const configCount = connection.headers.length + connection.protocols.length;
  const configOpen = configOpenOverride ?? configCount > 0;

  const handleConnect = () => {
    try {
      const resolvedUrl = resolveVariables(connection.url);
      const headers = keyValuePairsToRecord(connection.headers);
      websocketManager.connect(
        activeConnectionId,
        resolvedUrl,
        connection.protocols.length > 0 ? connection.protocols : undefined,
        Object.keys(headers).length > 0 ? headers : undefined
      );
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  };

  const handleDisconnect = () => {
    websocketManager.disconnect(activeConnectionId);
  };

  const handleSendMessage = () => {
    if (!message.trim()) return;

    if (sendFormat === 'binary') {
      try {
        const buffer = websocketManager.hexToArrayBuffer(message);
        websocketManager.send(activeConnectionId, buffer);
        setMessage('');
      } catch {
        addMessage(
          activeConnectionId,
          'system',
          `Invalid hex format: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}". Expected space-separated hex bytes (e.g., "48 65 6c 6c 6f")`
        );
      }
    } else {
      websocketManager.send(activeConnectionId, message);
      setMessage('');
    }
  };

  const handleClearMessages = () => {
    clearMessages(activeConnectionId);
    setSelectedMessageId(null);
  };

  const handleExportMessages = () => {
    const messages = connection.messages.map((msg) => ({
      timestamp: new Date(msg.timestamp).toISOString(),
      type: msg.type,
      dataType: msg.dataType,
      content: msg.content,
    }));

    const exportData = {
      url: connection.url,
      protocols: connection.protocols,
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `websocket-messages-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredMessages = getFilteredMessages(activeConnectionId);
  const selectedMessage =
    (selectedMessageId && connection.messages.find((m) => m.id === selectedMessageId)) || null;

  const byteCount = new Blob([message]).size;
  const sendDisabled = !isConnected || !message.trim();

  const statusLabel = isConnected
    ? 'CONNECTED'
    : connection.status === 'connecting'
      ? 'CONNECTING'
      : connection.status === 'reconnecting'
        ? `RECONNECTING (${connection.reconnectAttempts}/${connection.maxReconnectAttempts})`
        : 'DISCONNECTED';

  return (
    <div className="flex flex-1 flex-col gap-2.5 bg-transparent p-3 overflow-hidden">
      {/* Connection bar */}
      <Floater radius="pill" className="flex items-center gap-2 px-3 h-12 shrink-0">
        <ProtoChip protocol="WS" />
        <span className="text-sp-dim font-mono text-sp-13 select-none" aria-hidden="true">
          ›
        </span>
        <div className="flex-1 flex items-center gap-2 min-w-0">
          {isConnected || isConnecting ? (
            <span className="font-mono text-sp-13 text-sp-text truncate">
              <VariableText text={connection.url} />
            </span>
          ) : (
            <Input
              value={connection.url}
              onChange={(e) => updateConnectionUrl(activeConnectionId, e.target.value)}
              placeholder={ECHO_URLS.websocket}
              className="h-7 flex-1 bg-transparent border-0 px-1 font-mono text-sp-13 text-sp-text shadow-none placeholder:italic focus-visible:ring-0 focus-visible:ring-offset-0"
              aria-label="WebSocket URL"
            />
          )}
        </div>
        {!isConnected && !isConnecting && (
          <CountToggle
            label="Options"
            count={configCount}
            expanded={configOpen}
            onToggle={() => setConfigOpenOverride(!configOpen)}
          />
        )}
        <span
          className={cn(
            'inline-flex items-center gap-1.5 h-6 px-2.5 rounded-sp-pill font-mono font-bold text-sp-10 tracking-wide',
            isConnected && 'sp-accent-ring'
          )}
          style={{
            color: isConnected
              ? 'var(--color-success)'
              : isConnecting
                ? 'var(--color-warning)'
                : 'var(--color-neutral)',
            background: isConnected
              ? 'color-mix(in srgb, var(--color-success) 16%, transparent)'
              : isConnecting
                ? 'color-mix(in srgb, var(--color-warning) 16%, transparent)'
                : 'color-mix(in srgb, var(--color-neutral) 14%, transparent)',
            boxShadow: isConnected
              ? '0 0 0 1px color-mix(in srgb, var(--color-success) 40%, transparent), 0 0 12px color-mix(in srgb, var(--color-success) 35%, transparent)'
              : undefined,
          }}
          aria-live="polite"
          data-testid="websocket-status"
        >
          <span aria-hidden="true">●</span>
          {statusLabel}
        </span>
        {isConnected || isConnecting ? (
          <button
            type="button"
            onClick={handleDisconnect}
            className="inline-flex items-center h-7 px-3 rounded-sp-btn font-medium text-sp-12 border border-danger/35 text-danger bg-transparent transition-colors hover:bg-danger/10"
          >
            Disconnect
          </button>
        ) : (
          <Button
            variant="cta"
            size="cta"
            onClick={handleConnect}
            disabled={!connection.url}
            className="min-w-[80px]"
          >
            Connect
          </Button>
        )}
      </Floater>

      {/* Connection config (handshake headers + subprotocols) — only while
          disconnected, collapsed behind the Options toggle when empty so the
          message console stays above the fold. */}
      {configOpen && !isConnected && !isConnecting && (
        <Floater radius="panel" className="flex flex-col gap-3 px-3 py-3 shrink-0">
          <div>
            <label htmlFor="ws-subprotocols" className="text-sp-11 font-medium text-sp-muted">
              Subprotocols
            </label>
            <Input
              id="ws-subprotocols"
              value={connection.protocols.join(', ')}
              onChange={(e) =>
                setProtocols(
                  activeConnectionId,
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                )
              }
              placeholder="comma-separated, e.g. graphql-transport-ws"
              className="h-7 mt-1 font-mono text-sp-12"
              aria-label="WebSocket subprotocols"
            />
          </div>
          <div>
            <span className="text-sp-11 font-medium text-sp-muted">Handshake headers</span>
            <DesktopOnlyBadge title="The browser WebSocket API cannot send handshake headers — headers set here are only sent by the desktop app." />
            <div className="mt-1">
              <KeyValueEditor
                items={connection.headers}
                onAdd={() => addHeader(activeConnectionId)}
                onUpdate={(id, updates) => updateHeader(activeConnectionId, id, updates)}
                onDelete={(id) => removeHeader(activeConnectionId, id)}
                keyPlaceholder="Header"
                valuePlaceholder="Value"
                addButtonText="Add header"
                itemType="header"
              />
            </div>
          </div>
        </Floater>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-6 px-1 shrink-0">
        <UptimeStat connectedAt={connection.lastConnectedAt} isConnected={isConnected} />
        <Stat
          label="↑ Messages"
          value={<span style={{ color: 'var(--color-proto-ws)' }}>{counts.sent}</span>}
        />
        <Stat
          label="↓ Messages"
          value={<span style={{ color: 'var(--color-success)' }}>{counts.received}</span>}
        />
        <Stat label="Latency" value="—" />
        <Stat
          label="Protocol"
          value={connection.protocols.length > 0 ? connection.protocols[0] : 'default'}
        />
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="sp-label">Auto-reconnect</span>
          <ToggleField
            checked={connection.autoReconnect}
            onChange={(v) => setAutoReconnect(activeConnectionId, v)}
            disabled={isConnected}
            ariaLabel="Auto-reconnect"
            size="sm"
          />
        </div>
      </div>

      {/* Two columns */}
      <div className="flex flex-1 min-h-0 gap-2.5">
        {/* Event log (flex: 1.4) */}
        <Floater
          radius="panel"
          className="flex flex-col min-h-0 overflow-hidden"
          style={{ flex: 1.4 }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-3 h-10 border-b border-sp-line shrink-0">
            <span className="text-sp-13 font-medium text-sp-text">Messages</span>
            <span className="text-sp-11 text-sp-dim font-mono">({connection.messages.length})</span>
            <div className="flex-1" />
            <TextField
              size="sm"
              mono
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search…"
              leadingIcon={<Search className="h-3.5 w-3.5" />}
              className="w-44"
              aria-label="Search messages"
            />
            <Select
              value={messageFilter}
              onValueChange={(value) => setMessageFilter(value as WebSocketMessageType | 'all')}
            >
              <SelectTrigger
                aria-label="Filter messages"
                className="h-7 w-28 bg-sp-surface-lo border-sp-line text-sp-12 font-mono"
              >
                <Filter className="h-3 w-3 mr-1 text-sp-dim" />
                <SelectValue placeholder="Filter" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="received">Received</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={handleExportMessages}
              disabled={connection.messages.length === 0}
              aria-label="Download messages"
              title="Export messages as JSON"
              className="inline-flex h-7 w-7 items-center justify-center rounded-sp-btn text-sp-muted hover:bg-sp-hover hover:text-sp-text disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleClearMessages}
              disabled={connection.messages.length === 0}
              aria-label="Clear messages"
              title="Clear messages"
              className="inline-flex h-7 w-7 items-center justify-center rounded-sp-btn text-sp-muted hover:bg-sp-hover hover:text-sp-text disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Column header strip */}
          <div
            className="grid items-center gap-3 px-3 h-7 border-b border-sp-line shrink-0 sp-label"
            style={{ gridTemplateColumns: '52px 88px 64px 1fr' }}
          >
            <span>DIR</span>
            <span>TIME</span>
            <span>SIZE</span>
            <span>PREVIEW</span>
          </div>

          {/* Rows */}
          <div
            className="flex-1 min-h-0 overflow-auto font-mono"
            data-stream-rapid={rapidStream || undefined}
          >
            {filteredMessages.length === 0 ? (
              <div className="py-10 text-center text-sp-dim text-sp-12">
                {connection.messages.length === 0
                  ? 'No messages yet. Connect and start sending.'
                  : 'No messages match the current filter.'}
              </div>
            ) : (
              filteredMessages.map((msg) => {
                const selected = msg.id === selectedMessageId;
                return (
                  <button
                    key={msg.id}
                    type="button"
                    onClick={() => setSelectedMessageId(msg.id)}
                    className={cn(
                      'grid w-full items-center gap-3 px-3 py-1.5 text-left border-l-2 transition-colors sp-stream-row',
                      selected
                        ? 'bg-sp-active border-sp-accent'
                        : 'border-transparent hover:bg-sp-hover'
                    )}
                    style={{ gridTemplateColumns: '52px 88px 64px 1fr' }}
                  >
                    <DirTag type={msg.type} />
                    <span className="text-sp-dim text-sp-11 tabular-nums">
                      {formatTime(msg.timestamp)}
                    </span>
                    <span className="text-sp-dim text-sp-11">
                      {msg.dataType === 'binary' ? 'bin' : formatSize(msg.content)}
                    </span>
                    <span className="truncate text-sp-12 text-sp-text">
                      {previewContent(msg.content)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Floater>

        {/* Right column */}
        <div className="flex flex-col gap-2.5 min-h-0" style={{ flex: 1 }}>
          {/* Selected message */}
          <Floater radius="panel" className="flex flex-1 flex-col min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 px-3 h-10 border-b border-sp-line shrink-0">
              <span className="text-sp-13 font-medium text-sp-text">Selected message</span>
              {selectedMessage && (
                <span className="text-sp-11 text-sp-dim font-mono">
                  {formatTime(selectedMessage.timestamp)} · {formatSize(selectedMessage.content)}
                </span>
              )}
              <div className="flex-1" />
              {selectedMessage && (
                <button
                  type="button"
                  onClick={() => setSelectedMessageId(null)}
                  aria-label="Close selected message"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-sp-chip text-sp-muted hover:bg-sp-hover hover:text-sp-text"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden p-2">
              {selectedMessage ? (
                <CodeEditorFrame gutter={false} className="h-full">
                  <pre className="whitespace-pre-wrap break-words text-sp-12 text-sp-text">
                    {tryPrettyJson(selectedMessage.content)}
                  </pre>
                </CodeEditorFrame>
              ) : (
                <div className="flex h-full items-center justify-center text-sp-dim text-sp-12">
                  Select a message to inspect it.
                </div>
              )}
            </div>
          </Floater>

          {/* Compose */}
          <Floater radius="panel" className="flex flex-1 flex-col min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 px-3 h-10 border-b border-sp-line shrink-0">
              <span className="text-sp-13 font-medium text-sp-text">Compose</span>
              <div className="flex-1" />
              <Segmented<SendFormat>
                size="sm"
                value={sendFormat}
                onChange={setSendFormat}
                ariaLabel="Send format"
                options={[
                  { value: 'json', label: 'json' },
                  { value: 'text', label: 'text' },
                  { value: 'binary', label: 'binary' },
                ]}
              />
            </div>
            <div className="flex-1 min-h-0 overflow-hidden p-2">
              <CodeEditorFrame gutter={false} className="h-full">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  aria-label="Message to send"
                  placeholder={
                    sendFormat === 'binary'
                      ? 'Enter hex bytes (e.g., 48 65 6c 6c 6f)…'
                      : sendFormat === 'json'
                        ? '{ "type": "ping" }'
                        : 'Enter message to send…'
                  }
                  disabled={!isConnected}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  className="block h-full w-full resize-none bg-transparent text-sp-text font-mono text-sp-12 outline-none placeholder:text-sp-dim disabled:opacity-50"
                />
              </CodeEditorFrame>
            </div>
            <div className="flex items-center gap-2 px-3 h-10 border-t border-sp-line shrink-0">
              <Button
                variant="glow"
                size="sm"
                onClick={handleSendMessage}
                disabled={sendDisabled}
                className="h-7"
              >
                <Send className="h-3.5 w-3.5 mr-1" /> Send
              </Button>
              <Kbd size="xs">⌘↵</Kbd>
              <div className="flex-1" />
              <span className="text-sp-11 text-sp-dim font-mono tabular-nums">{byteCount} B</span>
            </div>
          </Floater>
        </div>
      </div>
    </div>
  );
}

export default withErrorBoundary(WebSocketClient);
