import { Filter, Search, Send, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { KeyValueTable } from '@/components/shared/KeyValueTable';
import {
  FreezeToggle,
  LogExportMenu,
  useFrozenView,
} from '@/components/shared/messageLog/MessageLogControls';
import { MessageTemplateList } from '@/components/shared/messageTemplates/MessageTemplateList';
import { StreamSplit } from '@/components/shared/StreamSplit';
import { VariableUrlInput } from '@/components/shared/VariableUrlInput';
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
import { WsDisconnectControl } from '@/features/websocket/components/WsDisconnectControl';
import { WsPingControl } from '@/features/websocket/components/WsPingControl';
import { startFrameAssertionWatcher } from '@/features/websocket/lib/frameAssertions';
import {
  sendComposedWebSocketMessage,
  sendFormatToTemplateFormat,
  templateFormatToSendFormat,
  type WebSocketSendFormat,
} from '@/features/websocket/lib/sendComposedMessage';
import { websocketManager } from '@/features/websocket/lib/websocketManager';
import type { WsCloseOptions } from '@/features/websocket/lib/wsControlFrames';
import { wsExportName, wsToLogEntries } from '@/features/websocket/lib/wsLogExport';
import type { WebSocketMessageType } from '@/features/websocket/store/useWebSocketStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { filteredEmptyText } from '@/lib/shared/messageLog';
import { isElectron } from '@/lib/shared/platform';
import { modLabel } from '@/lib/shared/shortcuts';
import {
  getWebSocketComposerDraft,
  setWebSocketComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import {
  newTemplateId,
  nextTemplateName,
  type WebSocketMessageTemplate,
} from '@/lib/shared/streaming/messageTemplates';
import { useComposerDraftSync } from '@/lib/shared/streaming/useComposerDraftSync';
import { useRapidAppendFlag } from '@/lib/shared/useRapidAppendFlag';
import { cn, keyValuePairsToRecord } from '@/lib/shared/utils';
import { useActiveTabId } from '@/store/selectors';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import {
  FrameAssertionBadge,
  FrameAssertionButton,
  FrameAssertionDetails,
} from './FrameAssertionControls';

type SendFormat = WebSocketSendFormat;

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
  const [frozen, setFrozen] = useState(false);
  // null = auto (open only when something is configured); boolean = user override.
  const [configOpenOverride, setConfigOpenOverride] = useState<boolean | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);
  const activeTabId = useActiveTabId();

  const connectionByTabId = useWebSocketStore((s) => s.connectionByTabId);
  const messageFilter = useWebSocketStore((s) => s.messageFilter);
  const searchQuery = useWebSocketStore((s) => s.searchQuery);
  const activeConnectionId = activeTabId ? (connectionByTabId[activeTabId] ?? null) : null;
  const connection = useWebSocketStore((s) =>
    activeConnectionId ? (s.connections[activeConnectionId] ?? null) : null
  );
  // Composer ⇄ draft map: an opened collection item seeds it; Save to
  // Collection reads it (#1209).
  useComposerDraftSync(
    activeConnectionId,
    { body: message, format: sendFormatToTemplateFormat(sendFormat) },
    getWebSocketComposerDraft,
    setWebSocketComposerDraft,
    (draft) => {
      setMessage(draft.body);
      setSendFormat(templateFormatToSendFormat(draft.format));
    },
    { body: '', format: 'json' }
  );
  const {
    ensureConnectionForTab,
    updateConnectionUrl,
    setAutoReconnect,
    clearMessages,
    setMessageFilter,
    setSearchQuery,
    getFilteredMessages,
    setHeaders,
    setProtocols,
    patchControlState,
    setTemplates,
    setFrameAssertion,
  } = useWebSocketStore(
    useShallow((s) => ({
      ensureConnectionForTab: s.ensureConnectionForTab,
      updateConnectionUrl: s.updateConnectionUrl,
      setAutoReconnect: s.setAutoReconnect,
      clearMessages: s.clearMessages,
      setMessageFilter: s.setMessageFilter,
      setSearchQuery: s.setSearchQuery,
      getFilteredMessages: s.getFilteredMessages,
      setHeaders: s.setHeaders,
      setProtocols: s.setProtocols,
      patchControlState: s.patchControlState,
      setTemplates: s.setTemplates,
      setFrameAssertion: s.setFrameAssertion,
    }))
  );

  useEffect(() => {
    if (activeTabId) ensureConnectionForTab(activeTabId);
  }, [activeTabId, ensureConnectionForTab]);

  // App-wide and idempotent: per-frame assertion scripts (#931) keep running
  // for background tabs, so the watcher is never torn down on unmount.
  useEffect(() => {
    startFrameAssertionWatcher();
  }, []);

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
  const filteredMessages = activeConnectionId ? getFilteredMessages(activeConnectionId) : [];
  const { visible: visibleMessages, newCount } = useFrozenView(filteredMessages, frozen);

  if (!connection || !activeConnectionId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-transparent">
        <p className="text-sp-12 text-sp-dim font-mono">Preparing WebSocket connection…</p>
      </div>
    );
  }

  const isConnected = connection.status === 'connected';
  const isConnecting = connection.status === 'connecting' || connection.status === 'reconnecting';
  const deflateDisabled = connection.perMessageDeflate === false;
  const configCount =
    connection.headers.length + connection.protocols.length + (deflateDisabled ? 1 : 0);
  // What the server accepted on the current connection (#923).
  const negotiated = isConnected ? connection.negotiated : undefined;
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

  const handleDisconnect = (close?: WsCloseOptions) => {
    websocketManager.disconnect(activeConnectionId, true, close);
  };

  // {{var}} resolution, unresolved warnings and secret masking live in the
  // helper (#927); the composer keeps the unresolved text.
  const handleSendMessage = () => {
    if (sendComposedWebSocketMessage(activeConnectionId, message, sendFormat)) setMessage('');
  };
  const templates = connection.templates ?? [];
  const createTemplate = (): WebSocketMessageTemplate | null =>
    message.trim()
      ? {
          id: newTemplateId(),
          name: nextTemplateName(templates, 'Message'),
          body: message,
          format: sendFormatToTemplateFormat(sendFormat),
        }
      : null;

  const handleClearMessages = () => {
    clearMessages(activeConnectionId);
    setSelectedMessageId(null);
  };

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

  const configPanel = (
    <Floater radius="panel" className="flex h-full flex-col gap-3 overflow-auto px-3 py-3">
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
          {/* Handshake headers are sent as typed — no {{var}} resolution. */}
          <KeyValueTable
            items={connection.headers}
            onChange={(headers) => setHeaders(activeConnectionId, headers)}
            itemLabel="header"
            addLabel="Add header"
            httpHeaders
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ToggleField
          checked={!deflateDisabled}
          onChange={(v) => patchControlState(activeConnectionId, { perMessageDeflate: v })}
          disabled={!isElectron()}
          ariaLabel="Offer permessage-deflate compression"
          size="sm"
        />
        <span className="text-sp-11 font-medium text-sp-muted">
          Offer permessage-deflate compression
        </span>
        <DesktopOnlyBadge title="The browser always negotiates compression itself — the permessage-deflate offer can only be turned off in the desktop app." />
      </div>
    </Floater>
  );

  const logPanel = (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 h-full">
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
        <Stat
          label="Latency"
          value={connection.lastPingRttMs !== undefined ? `${connection.lastPingRttMs} ms` : '—'}
        />
        <Stat
          label="Protocol"
          value={
            negotiated
              ? negotiated.protocol || 'none'
              : connection.protocols.length > 0
                ? connection.protocols[0]
                : 'default'
          }
        />
        {negotiated?.extensions ? <Stat label="Extensions" value={negotiated.extensions} /> : null}
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
            <FreezeToggle frozen={frozen} newCount={newCount} onChange={setFrozen} />
            <FrameAssertionButton
              config={connection.frameAssertion}
              onChange={(config) => setFrameAssertion(activeConnectionId, config)}
            />
            <LogExportMenu
              entries={() => wsToLogEntries(filteredMessages)}
              name={wsExportName(connection.url)}
              meta={{ protocol: 'websocket', url: connection.url, protocols: connection.protocols }}
              disabled={connection.messages.length === 0}
            />
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
            {visibleMessages.length === 0 ? (
              <div className="py-10 text-center text-sp-dim text-sp-12">
                {connection.messages.length === 0
                  ? 'No messages yet. Connect and start sending.'
                  : filteredEmptyText('message', newCount)}
              </div>
            ) : (
              visibleMessages.map((msg) => {
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
                    <span className="flex min-w-0 items-center text-sp-12 text-sp-text">
                      <span className="truncate">{previewContent(msg.content)}</span>
                      <FrameAssertionBadge result={msg.assertion} />
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
                  <FrameAssertionDetails result={selectedMessage.assertion} />
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
              <CountToggle
                label="Saved"
                count={templates.length}
                expanded={templatesOpen}
                onToggle={() => setTemplatesOpen(!templatesOpen)}
              />
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
            {templatesOpen && (
              <div className="shrink-0 border-b border-sp-line px-2 py-1.5">
                <MessageTemplateList<WebSocketMessageTemplate>
                  templates={templates}
                  onChange={(next) => setTemplates(activeConnectionId, next)}
                  onLoad={(t) => {
                    setMessage(t.body);
                    setSendFormat(templateFormatToSendFormat(t.format));
                  }}
                  onSend={(t) =>
                    sendComposedWebSocketMessage(
                      activeConnectionId,
                      t.body,
                      templateFormatToSendFormat(t.format)
                    )
                  }
                  createFromComposer={createTemplate}
                  canSend={isConnected}
                  describe={(t) => `${t.format} · ${previewContent(t.body)}`}
                  noun="message"
                />
              </div>
            )}
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
              <Kbd size="xs">{modLabel('↵')}</Kbd>
              <div className="flex-1" />
              <span className="text-sp-11 text-sp-dim font-mono tabular-nums">{byteCount} B</span>
            </div>
          </Floater>
        </div>
      </div>
    </div>
  );

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
            <VariableUrlInput
              value={connection.url}
              onValueChange={(url) => updateConnectionUrl(activeConnectionId, url)}
              variableScope="connection"
              placeholder={ECHO_URLS.websocket}
              aria-label="WebSocket URL"
              className="h-7 flex-1"
              textClassName="px-1 text-sp-13 placeholder:italic"
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
          <>
            <WsPingControl
              disabled={!isConnected}
              onPing={(payload) => websocketManager.ping(activeConnectionId, payload)}
            />
            <WsDisconnectControl onDisconnect={handleDisconnect} />
          </>
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
          message console stays above the fold. Open, it gets a resizable pane
          above the log. */}
      {configOpen && !isConnected && !isConnecting ? (
        <StreamSplit
          config={<div className="h-full pb-2.5">{configPanel}</div>}
          log={<div className="h-full pt-2.5">{logPanel}</div>}
        />
      ) : (
        logPanel
      )}
    </div>
  );
}

export default withErrorBoundary(WebSocketClient);
