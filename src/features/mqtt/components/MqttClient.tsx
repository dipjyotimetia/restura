import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Send, Trash2, Plug, PlugZap, RefreshCw, Search, Pause, Play } from 'lucide-react';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { cn } from '@/lib/shared/utils';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { useActiveTabId } from '@/store/selectors';
import { Floater, ProtoChip, Stat, VariableText, CodeEditorFrame } from '@/components/ui/spatial';
import { useMqttStore, MQTT_SECRET_SENTINEL } from '@/features/mqtt/store/useMqttStore';
import type { MqttMessage, MqttProtocolVersion, MqttQoS } from '@/features/mqtt/store/useMqttStore';
import { mqttManager, mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import { secureStorage } from '@/lib/shared/secure-storage';

const MQTT_GREEN = '#10b981';
const QOS_VALUES: MqttQoS[] = [0, 1, 2];

function StatusBadge({ label, tone }: { label: string; tone: 'green' | 'amber' | 'muted' }) {
  const palette = {
    green: { color: '#22c55e', bg: 'rgba(34,197,94,0.16)', glow: '0 0 8px rgba(34,197,94,0.35)' },
    amber: { color: '#f59e0b', bg: 'rgba(245,158,11,0.16)', glow: '0 0 8px rgba(245,158,11,0.35)' },
    muted: { color: '#94a3b8', bg: 'rgba(148,163,184,0.16)', glow: 'none' as const },
  }[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 h-7 px-2.5 font-mono font-bold uppercase tracking-wide text-sp-11 rounded-sp-btn"
      style={{ color: palette.color, background: palette.bg, boxShadow: palette.glow }}
    >
      <span aria-hidden="true">●</span>
      {label}
    </span>
  );
}

function QosPill({ qos }: { qos: MqttQoS }) {
  const colors = ['#94a3b8', '#3b82f6', '#a855f7'] as const;
  const color = colors[qos];
  return (
    <span
      className="inline-flex items-center justify-center h-5 px-1.5 font-mono font-bold text-sp-9 rounded-sp-chip"
      style={{ color, background: `${color}26`, border: `1px solid ${color}40` }}
    >
      Q{qos}
    </span>
  );
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/**
 * One row in the message log. Memoized so a high-throughput batch only renders
 * the newly-arrived rows — `capMessages`/`addMessages` preserve object identity
 * for existing messages, so unchanged rows skip reconciliation entirely.
 * `onSelect` must be a stable reference for the memo to hold.
 */
const MessageRow = memo(function MessageRow({
  m,
  selected,
  onSelect,
}: {
  m: MqttMessage;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li
      onClick={() => onSelect(m.id)}
      className={cn(
        'grid items-center gap-2 px-3 py-1.5 cursor-pointer font-mono border-l-2 transition-colors',
        selected ? 'bg-sp-active border-l-sp-accent' : 'border-l-transparent hover:bg-sp-hover'
      )}
      style={{ gridTemplateColumns: '40px 50px 110px 1fr' }}
    >
      <div>
        <QosPill qos={m.qos} />
      </div>
      <span className="text-sp-dim">
        {m.retain ? <span style={{ color: MQTT_GREEN }}>R</span> : '—'}
      </span>
      <span className="text-sp-dim tabular-nums">{new Date(m.timestamp).toLocaleTimeString()}</span>
      <span className="truncate">
        {m.topic && (
          <span style={{ color: MQTT_GREEN }} className="mr-2">
            {m.topic}
          </span>
        )}
        <span className={cn(m.error ? 'text-red-400' : 'text-sp-text')} title={m.payload}>
          {m.error ? m.error : m.payload}
        </span>
      </span>
    </li>
  );
});

/** Compact 0/1/2 QoS picker. The Publish tab uses its own labelled variant. */
function QosSelect({
  value,
  onChange,
  triggerClassName = 'h-8 text-xs',
}: {
  value: MqttQoS;
  onChange: (qos: MqttQoS) => void;
  triggerClassName?: string;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v) as MqttQoS)}>
      <SelectTrigger className={triggerClassName}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {QOS_VALUES.map((q) => (
          <SelectItem key={q} value={String(q)}>
            {q}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DesktopOnlyPanel() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Floater radius="panel" className="max-w-md p-6 text-center space-y-3">
        <h2 className="text-lg font-semibold text-sp-text">MQTT is a desktop-only feature</h2>
        <p className="text-sm text-sp-muted">
          The MQTT client opens raw TCP/TLS sockets to your broker, which the browser cannot do.
          Download the Restura desktop app to publish and subscribe over MQTT.
        </p>
      </Floater>
    </div>
  );
}

function statusTone(status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'): {
  label: string;
  tone: 'green' | 'amber' | 'muted';
} {
  switch (status) {
    case 'connected':
      return { label: 'Connected', tone: 'green' };
    case 'connecting':
      return { label: 'Connecting', tone: 'amber' };
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'amber' };
    default:
      return { label: 'Disconnected', tone: 'muted' };
  }
}

function MqttClient() {
  const isDesktop = isElectron();
  const activeTabId = useActiveTabId();

  const connectionByTabId = useMqttStore((s) => s.connectionByTabId);
  const messageFilter = useMqttStore((s) => s.messageFilter);
  const searchQuery = useMqttStore((s) => s.searchQuery);
  const activeConnectionId = activeTabId ? (connectionByTabId[activeTabId] ?? null) : null;
  const connection = useMqttStore((s) =>
    activeConnectionId ? (s.connections[activeConnectionId] ?? null) : null
  );
  const {
    ensureConnectionForTab,
    removeConnection,
    updateConnection,
    updateTls,
    updateLwt,
    clearMessages,
    setMessageFilter,
    setSearchQuery,
    getFilteredMessages,
  } = useMqttStore(
    useShallow((s) => ({
      ensureConnectionForTab: s.ensureConnectionForTab,
      removeConnection: s.removeConnection,
      updateConnection: s.updateConnection,
      updateTls: s.updateTls,
      updateLwt: s.updateLwt,
      clearMessages: s.clearMessages,
      setMessageFilter: s.setMessageFilter,
      setSearchQuery: s.setSearchQuery,
      getFilteredMessages: s.getFilteredMessages,
    }))
  );

  useEffect(() => {
    if (activeTabId && isDesktop) ensureConnectionForTab(activeTabId);
  }, [activeTabId, ensureConnectionForTab, isDesktop]);

  const [passwordDraft, setPasswordDraft] = useState('');
  const [passphraseDraft, setPassphraseDraft] = useState('');
  const [pubTopic, setPubTopic] = useState('');
  const [pubPayload, setPubPayload] = useState('');
  const [pubQos, setPubQos] = useState<MqttQoS>(0);
  const [pubRetain, setPubRetain] = useState(false);
  const [subTopic, setSubTopic] = useState('');
  const [subQos, setSubQos] = useState<MqttQoS>(0);
  const [activeTab, setActiveTab] = useState('messages');
  const [paused, setPaused] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

  // Reset drafts when switching connections.
  useEffect(() => {
    setPasswordDraft('');
    setPassphraseDraft('');
    setPubTopic('');
    setPubPayload('');
    setSubTopic('');
    setSelectedMessageId(null);
    setPaused(false);
  }, [activeConnectionId]);

  const connectionId = connection?.id;
  const connectionMessages = connection?.messages;

  const filteredMessages = useMemo(
    () => (connectionId ? getFilteredMessages(connectionId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectionId, connectionMessages, messageFilter, searchQuery]
  );

  const msgPerSec = useMemo(() => {
    if (!connectionMessages) return 0;
    const cutoff = Date.now() - 5_000;
    const recent = connectionMessages.filter(
      (m) => m.direction === 'received' && m.timestamp >= cutoff
    );
    return Math.round((recent.length / 5) * 10) / 10;
  }, [connectionMessages]);

  const [pausedSnapshot, setPausedSnapshot] = useState<MqttMessage[] | null>(null);
  useEffect(() => {
    setPausedSnapshot(paused ? filteredMessages : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);
  const visibleMessages = paused && pausedSnapshot ? pausedSnapshot : filteredMessages;

  const selectedMessage: MqttMessage | null = useMemo(() => {
    if (!connectionMessages || !selectedMessageId) return null;
    return connectionMessages.find((m) => m.id === selectedMessageId) ?? null;
  }, [connectionMessages, selectedMessageId]);

  // Stable identity so memoized rows don't re-render on every parent update.
  const handleSelectMessage = useCallback((id: string) => setSelectedMessageId(id), []);

  if (!isDesktop) {
    return <DesktopOnlyPanel />;
  }

  const handleConnect = async (): Promise<void> => {
    if (!connection) return;
    let next = connection;
    if (passwordDraft) {
      secureStorage.set(mqttSecretKey(connection.id, 'password'), passwordDraft);
      updateConnection(connection.id, { password: MQTT_SECRET_SENTINEL });
      next = { ...next, password: MQTT_SECRET_SENTINEL };
      setPasswordDraft('');
    }
    if (passphraseDraft) {
      secureStorage.set(mqttSecretKey(connection.id, 'tls-passphrase'), passphraseDraft);
      const tls = { ...(connection.tls ?? {}), passphrase: MQTT_SECRET_SENTINEL };
      updateTls(connection.id, tls);
      next = { ...next, tls };
      setPassphraseDraft('');
    }
    await mqttManager.connect(next);
  };

  const handleDisconnect = async (): Promise<void> => {
    if (!connection) return;
    await mqttManager.disconnect(connection.id);
  };

  const handlePublish = async (): Promise<void> => {
    if (!connection || !pubTopic) return;
    await mqttManager.publish({
      connectionId: connection.id,
      topic: pubTopic,
      payload: pubPayload,
      qos: pubQos,
      retain: pubRetain,
    });
    setPubPayload('');
  };

  const handleSubscribe = async (): Promise<void> => {
    if (!connection || !subTopic.trim()) return;
    await mqttManager.subscribe({
      connectionId: connection.id,
      topicFilter: subTopic.trim(),
      qos: subQos,
    });
    setSubTopic('');
  };

  const handleUnsubscribe = async (topicFilter: string): Promise<void> => {
    if (!connection) return;
    await mqttManager.unsubscribe(connection.id, topicFilter);
  };

  const pickTlsFile = async (field: 'caPath' | 'certPath' | 'keyPath'): Promise<void> => {
    if (!connection) return;
    const api = getElectronAPI();
    if (!api) return;
    const result = await api.dialog.openFile({
      filters: [
        { name: 'PEM / KEY', extensions: ['pem', 'crt', 'cer', 'key'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return;
    updateTls(connection.id, { ...(connection.tls ?? {}), [field]: result.filePaths[0] });
  };

  const isTls = connection?.brokerUrl.startsWith('mqtts://') ?? false;
  const isConnected = connection?.status === 'connected';
  // Only offer Connect from a fully idle state — while connecting/reconnecting
  // the client is live, so the action is Disconnect (re-clicking Connect would
  // re-bind listeners).
  const canConnect = connection?.status === 'disconnected';
  const badge = connection ? statusTone(connection.status) : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden gap-3 p-3 bg-sp-bg">
      {/* Connection bar */}
      <Floater radius="pill" className="flex flex-wrap items-center gap-2 px-3 py-2 shrink-0">
        <ProtoChip protocol="MQTT" />
        <span className="text-sp-dim font-mono text-sp-12 select-none">›</span>

        {connection && (
          <span className="font-mono text-sp-13 text-sp-text truncate max-w-[260px]">
            <VariableText text={connection.brokerUrl} />
          </span>
        )}
        {connection && (
          <Badge variant="outline" className="font-mono text-sp-10">
            {connection.protocolVersion === 5 ? 'v5.0' : 'v3.1.1'}
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-2">
          {badge && <StatusBadge label={badge.label} tone={badge.tone} />}

          <Button
            size="sm"
            variant="outline"
            onClick={() => setPaused((p) => !p)}
            className="h-7 px-2.5 text-xs font-mono rounded-sp-btn"
            disabled={!connection}
            title={paused ? 'Resume log' : 'Pause log'}
          >
            {paused ? (
              <>
                <Play className="h-3 w-3 mr-1.5" /> Resume
              </>
            ) : (
              <>
                <Pause className="h-3 w-3 mr-1.5" /> Pause
              </>
            )}
          </Button>

          {connection && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => removeConnection(connection.id)}
              title="Delete connection"
              className="h-7 w-7 p-0 rounded-sp-btn"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}

          {connection && canConnect && (
            <Button
              variant="glow"
              size="sm"
              onClick={handleConnect}
              className="h-7 min-w-[88px] text-xs font-medium rounded-sp-btn"
            >
              <Plug className="h-3.5 w-3.5 mr-1.5" /> Connect
            </Button>
          )}
          {connection && !canConnect && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDisconnect}
              className="h-7 min-w-[88px] text-xs font-medium rounded-sp-btn"
            >
              <PlugZap className="h-3.5 w-3.5 mr-1.5" /> Disconnect
            </Button>
          )}
        </div>
      </Floater>

      {!connection ? (
        <Floater
          radius="panel"
          className="flex flex-1 items-center justify-center text-sm text-sp-muted"
        >
          No connection — open a new MQTT tab to create one.
        </Floater>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 flex flex-col min-h-0 gap-3"
        >
          <TabsList className="w-fit shrink-0">
            <TabsTrigger value="messages">Messages ({connection.messages.length})</TabsTrigger>
            <TabsTrigger value="publish">Publish</TabsTrigger>
            <TabsTrigger value="subscribe">
              Subscribe ({connection.subscriptions.length})
            </TabsTrigger>
            <TabsTrigger value="connection">Connection</TabsTrigger>
          </TabsList>

          {/* Messages tab */}
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

            <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
              {/* Message log */}
              <Floater radius="panel" className="flex flex-col min-h-0 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-sp-line shrink-0">
                  <Select
                    value={messageFilter}
                    onValueChange={(v) =>
                      setMessageFilter(v as 'sent' | 'received' | 'system' | 'all')
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
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search topic, payload"
                      className="h-7 pl-7 text-xs bg-sp-surface-lo border-sp-line font-mono"
                    />
                  </div>
                  {paused && <StatusBadge label="Paused" tone="amber" />}
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
                  style={{ gridTemplateColumns: '40px 50px 110px 1fr' }}
                >
                  <span className="sp-label">QoS</span>
                  <span className="sp-label">Ret</span>
                  <span className="sp-label">Time</span>
                  <span className="sp-label">Topic / Payload</span>
                </div>

                <ScrollArea className="flex-1 min-h-0">
                  <ul className="text-xs">
                    {visibleMessages.map((m) => (
                      <MessageRow
                        key={m.id}
                        m={m}
                        selected={m.id === selectedMessageId}
                        onSelect={handleSelectMessage}
                      />
                    ))}
                    {visibleMessages.length === 0 && (
                      <li className="px-3 py-8 text-center text-sp-muted">No messages yet.</li>
                    )}
                  </ul>
                </ScrollArea>
              </Floater>

              {/* Detail panel */}
              <Floater radius="panel" className="flex flex-col min-h-0 overflow-hidden">
                {selectedMessage ? (
                  <>
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-sp-line shrink-0">
                      <span className="sp-label">Message</span>
                      <QosPill qos={selectedMessage.qos} />
                      {selectedMessage.retain && (
                        <span className="font-mono text-sp-11" style={{ color: MQTT_GREEN }}>
                          retained
                        </span>
                      )}
                      <span className="ml-auto font-mono text-sp-11 text-sp-dim">
                        {new Date(selectedMessage.timestamp).toLocaleString()}
                      </span>
                    </div>

                    <ScrollArea className="flex-1 min-h-0">
                      <div className="p-3 space-y-3">
                        {selectedMessage.topic && (
                          <div className="space-y-1">
                            <div className="sp-label">Topic</div>
                            <div className="font-mono text-sp-12" style={{ color: MQTT_GREEN }}>
                              {selectedMessage.topic}
                            </div>
                          </div>
                        )}

                        {selectedMessage.userProperties &&
                          Object.keys(selectedMessage.userProperties).length > 0 && (
                            <div className="space-y-1">
                              <div className="sp-label">User properties (v5)</div>
                              <div
                                className="grid gap-x-3 gap-y-1 font-mono text-sp-11-5"
                                style={{ gridTemplateColumns: 'auto 1fr' }}
                              >
                                {Object.entries(selectedMessage.userProperties).map(([k, v]) => (
                                  <div key={k} className="contents">
                                    <span className="text-sp-muted">{k}</span>
                                    <span className="text-sp-text break-all">
                                      {Array.isArray(v) ? v.join(', ') : v}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                        <div className="space-y-1">
                          <div className="sp-label">Payload</div>
                          {(() => {
                            const formatted = formatJson(selectedMessage.payload);
                            const lineCount = formatted.split('\n').length;
                            return (
                              <CodeEditorFrame lineCount={lineCount}>
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

          {/* Publish tab */}
          <TabsContent value="publish" className="flex-1 overflow-auto m-0">
            <Floater radius="panel" className="p-4 space-y-3">
              <div className="space-y-2">
                <Label className="text-xs sp-label">Topic</Label>
                <Input
                  value={pubTopic}
                  onChange={(e) => setPubTopic(e.target.value)}
                  placeholder="restura/test"
                  className="h-8 text-xs font-mono"
                  style={{ color: pubTopic ? MQTT_GREEN : undefined }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label className="text-xs sp-label">QoS</Label>
                  <Select
                    value={String(pubQos)}
                    onValueChange={(v) => setPubQos(Number(v) as MqttQoS)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0 — at most once</SelectItem>
                      <SelectItem value="1">1 — at least once</SelectItem>
                      <SelectItem value="2">2 — exactly once</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs sp-label">Retain</Label>
                  <div className="flex items-center gap-2 h-8">
                    <Switch checked={pubRetain} onCheckedChange={setPubRetain} />
                    <Label className="text-xs">Retain message on broker</Label>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs sp-label">Payload</Label>
                <Textarea
                  value={pubPayload}
                  onChange={(e) => setPubPayload(e.target.value)}
                  className="font-mono text-xs"
                  rows={8}
                />
              </div>
              <Button onClick={handlePublish} disabled={!isConnected || !pubTopic}>
                <Send className="h-3.5 w-3.5 mr-1.5" /> Publish
              </Button>
            </Floater>
          </TabsContent>

          {/* Subscribe tab */}
          <TabsContent value="subscribe" className="flex-1 overflow-auto m-0">
            <Floater radius="panel" className="p-4 space-y-3">
              <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 120px auto' }}>
                <div className="space-y-2">
                  <Label className="text-xs sp-label">Topic filter</Label>
                  <Input
                    value={subTopic}
                    onChange={(e) => setSubTopic(e.target.value)}
                    placeholder="restura/+/temp  or  sensors/#"
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs sp-label">QoS</Label>
                  <QosSelect value={subQos} onChange={setSubQos} />
                </div>
                <div className="flex items-end">
                  <Button onClick={handleSubscribe} disabled={!isConnected || !subTopic.trim()}>
                    Subscribe
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs sp-label">Active subscriptions</Label>
                {connection.subscriptions.length === 0 ? (
                  <div className="text-sp-dim text-sp-11-5 italic">No active subscriptions.</div>
                ) : (
                  <ul className="space-y-1">
                    {connection.subscriptions.map((s) => (
                      <li
                        key={s.topicFilter}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-sp-btn border border-sp-line bg-sp-surface-lo"
                      >
                        <span className="font-mono text-sp-12" style={{ color: MQTT_GREEN }}>
                          {s.topicFilter}
                        </span>
                        {s.grantedQos !== undefined && <QosPill qos={s.grantedQos} />}
                        <Badge variant="outline" className="font-mono text-sp-10">
                          {s.status}
                        </Badge>
                        <button
                          className="ml-auto text-sp-dim hover:text-red-400"
                          onClick={() => handleUnsubscribe(s.topicFilter)}
                          aria-label={`Unsubscribe ${s.topicFilter}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Floater>
          </TabsContent>

          {/* Connection tab */}
          <TabsContent value="connection" className="flex-1 overflow-auto m-0">
            <Floater radius="panel" className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs sp-label">Connection name</Label>
                  <Input
                    value={connection.name}
                    onChange={(e) => updateConnection(connection.id, { name: e.target.value })}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs sp-label">MQTT version</Label>
                  <Select
                    value={String(connection.protocolVersion)}
                    onValueChange={(v) =>
                      updateConnection(connection.id, {
                        protocolVersion: Number(v) as MqttProtocolVersion,
                      })
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5.0</SelectItem>
                      <SelectItem value="4">3.1.1</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs sp-label">Broker URL</Label>
                <Input
                  value={connection.brokerUrl}
                  onChange={(e) => updateConnection(connection.id, { brokerUrl: e.target.value })}
                  placeholder="mqtt://localhost:1883"
                  className="h-8 text-xs font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs sp-label">Client ID</Label>
                  <Input
                    value={connection.clientId}
                    onChange={(e) => updateConnection(connection.id, { clientId: e.target.value })}
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs sp-label">Keepalive (seconds)</Label>
                  <Input
                    type="number"
                    value={connection.keepalive}
                    onChange={(e) =>
                      updateConnection(connection.id, { keepalive: Number(e.target.value) || 0 })
                    }
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs sp-label">Connect timeout (ms)</Label>
                  <Input
                    type="number"
                    value={connection.connectTimeout}
                    onChange={(e) =>
                      updateConnection(connection.id, {
                        connectTimeout: Number(e.target.value) || 30_000,
                      })
                    }
                    className="h-8 text-xs font-mono"
                  />
                </div>
                {connection.protocolVersion === 5 && (
                  <div className="space-y-2">
                    <Label className="text-xs sp-label">Session expiry (s, v5)</Label>
                    <Input
                      type="number"
                      value={connection.sessionExpiryInterval ?? ''}
                      onChange={(e) =>
                        updateConnection(connection.id, {
                          sessionExpiryInterval: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      placeholder="optional"
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={connection.cleanStart}
                    onCheckedChange={(checked) =>
                      updateConnection(connection.id, { cleanStart: checked })
                    }
                  />
                  <Label className="text-xs">
                    {connection.protocolVersion === 5 ? 'Clean start' : 'Clean session'}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={connection.autoReconnect}
                    onCheckedChange={(checked) =>
                      updateConnection(connection.id, { autoReconnect: checked })
                    }
                  />
                  <Label className="text-xs">Auto-reconnect</Label>
                </div>
              </div>

              {/* Credentials */}
              <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
                <Label className="text-xs sp-label">Credentials</Label>
                <Input
                  value={connection.username ?? ''}
                  onChange={(e) =>
                    updateConnection(connection.id, { username: e.target.value || undefined })
                  }
                  placeholder="Username (optional)"
                  className="h-8 text-xs font-mono"
                />
                <Input
                  type="password"
                  value={passwordDraft}
                  onChange={(e) => setPasswordDraft(e.target.value)}
                  placeholder={
                    connection.password === MQTT_SECRET_SENTINEL
                      ? 'Password (stored — leave blank to keep)'
                      : 'Password (optional)'
                  }
                  className="h-8 text-xs font-mono"
                />
              </div>

              {/* TLS — only meaningful for mqtts:// */}
              {isTls && (
                <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
                  <Label className="text-xs sp-label">TLS (mqtts)</Label>
                  {(['caPath', 'certPath', 'keyPath'] as const).map((field) => (
                    <div key={field} className="flex gap-2">
                      <Input
                        value={connection.tls?.[field] ?? ''}
                        readOnly
                        placeholder={field}
                        className="h-8 text-xs font-mono"
                      />
                      <Button size="sm" variant="secondary" onClick={() => pickTlsFile(field)}>
                        Browse
                      </Button>
                    </div>
                  ))}
                  <Input
                    type="password"
                    value={passphraseDraft}
                    onChange={(e) => setPassphraseDraft(e.target.value)}
                    placeholder={
                      connection.tls?.passphrase === MQTT_SECRET_SENTINEL
                        ? 'Key passphrase (stored — leave blank to keep)'
                        : 'Key passphrase (optional)'
                    }
                    className="h-8 text-xs font-mono"
                  />
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={connection.tls?.rejectUnauthorized !== false}
                      onCheckedChange={(checked) =>
                        updateTls(connection.id, {
                          ...(connection.tls ?? {}),
                          rejectUnauthorized: checked,
                        })
                      }
                    />
                    <Label className="text-xs">Verify server certificate</Label>
                  </div>
                </div>
              )}

              {/* Last Will & Testament */}
              <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={connection.lwt !== undefined}
                    onCheckedChange={(checked) =>
                      updateLwt(
                        connection.id,
                        checked ? { topic: '', payload: '', qos: 0, retain: false } : undefined
                      )
                    }
                  />
                  <Label className="text-xs sp-label">Last Will &amp; Testament</Label>
                </div>
                {connection.lwt && (
                  <>
                    <Input
                      value={connection.lwt.topic}
                      onChange={(e) =>
                        updateLwt(connection.id, { ...connection.lwt!, topic: e.target.value })
                      }
                      placeholder="Will topic"
                      className="h-8 text-xs font-mono"
                    />
                    <Textarea
                      value={connection.lwt.payload}
                      onChange={(e) =>
                        updateLwt(connection.id, { ...connection.lwt!, payload: e.target.value })
                      }
                      placeholder="Will payload"
                      className="font-mono text-xs"
                      rows={2}
                    />
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">QoS</Label>
                        <QosSelect
                          value={connection.lwt.qos}
                          onChange={(qos) => updateLwt(connection.id, { ...connection.lwt!, qos })}
                          triggerClassName="h-7 w-16 text-xs"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={connection.lwt.retain}
                          onCheckedChange={(checked) =>
                            updateLwt(connection.id, { ...connection.lwt!, retain: checked })
                          }
                        />
                        <Label className="text-xs">Retain</Label>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Floater>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

export default withErrorBoundary(MqttClient);
