import { Pause, Play, Plug, PlugZap, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ConnectionBadge,
  Floater,
  ProtoChip,
  VariableText,
  type ConnectionTone,
} from '@/components/ui/spatial';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { mqttManager, mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import type { MqttMessage, MqttQoS } from '@/features/mqtt/store/useMqttStore';
import { MQTT_SECRET_SENTINEL, useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { secureStorage } from '@/lib/shared/secure-storage';
import { useRapidAppendFlag } from '@/lib/shared/useRapidAppendFlag';
import { useActiveTabId } from '@/store/selectors';
import { MqttConnectionForm } from './MqttConnectionForm';
import { MqttMessagesPanel } from './MqttMessagesPanel';
import { MqttSubscriptionsPanel } from './MqttSubscriptionsPanel';
import { MQTT_GREEN } from './mqttUi';

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
  tone: ConnectionTone;
} {
  switch (status) {
    case 'connected':
      return { label: 'Connected', tone: 'success' };
    case 'connecting':
      return { label: 'Connecting', tone: 'warning' };
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'warning' };
    default:
      return { label: 'Disconnected', tone: 'neutral' };
  }
}

function MqttClient() {
  const isDesktop = isElectron();
  const activeTabId = useActiveTabId();
  const connectionByTabId = useMqttStore((state) => state.connectionByTabId);
  const messageFilter = useMqttStore((state) => state.messageFilter);
  const searchQuery = useMqttStore((state) => state.searchQuery);
  const activeConnectionId = activeTabId ? (connectionByTabId[activeTabId] ?? null) : null;
  const connection = useMqttStore((state) =>
    activeConnectionId ? (state.connections[activeConnectionId] ?? null) : null
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
    useShallow((state) => ({
      ensureConnectionForTab: state.ensureConnectionForTab,
      removeConnection: state.removeConnection,
      updateConnection: state.updateConnection,
      updateTls: state.updateTls,
      updateLwt: state.updateLwt,
      clearMessages: state.clearMessages,
      setMessageFilter: state.setMessageFilter,
      setSearchQuery: state.setSearchQuery,
      getFilteredMessages: state.getFilteredMessages,
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
    [connectionId, connectionMessages, getFilteredMessages, messageFilter, searchQuery]
  );
  const msgPerSec = useMemo(() => {
    if (!connectionMessages) return 0;
    const cutoff = Date.now() - 5_000;
    const recent = connectionMessages.filter(
      (message) => message.direction === 'received' && message.timestamp >= cutoff
    );
    return Math.round((recent.length / 5) * 10) / 10;
  }, [connectionMessages]);
  const [pausedSnapshot, setPausedSnapshot] = useState<MqttMessage[] | null>(null);
  useEffect(() => {
    setPausedSnapshot(paused ? filteredMessages : null);
  }, [paused]);
  const visibleMessages = paused && pausedSnapshot ? pausedSnapshot : filteredMessages;
  const selectedMessage = useMemo(() => {
    if (!connectionMessages || !selectedMessageId) return null;
    return connectionMessages.find((message) => message.id === selectedMessageId) ?? null;
  }, [connectionMessages, selectedMessageId]);
  // Stable identity lets memoized message rows skip reconciliation during fast streams.
  const handleSelectMessage = useCallback((id: string) => setSelectedMessageId(id), []);
  const rapidStream = useRapidAppendFlag(connectionMessages?.length ?? 0);

  if (!isDesktop) return <DesktopOnlyPanel />;

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
    if (connection) await mqttManager.disconnect(connection.id);
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
    if (connection) await mqttManager.unsubscribe(connection.id, topicFilter);
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

  const isConnected = connection?.status === 'connected';
  // Connect only from the idle state; reconnecting must retain one listener set.
  const canConnect = connection?.status === 'disconnected';
  const badge = connection ? statusTone(connection.status) : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden gap-2.5 p-3 bg-transparent">
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
          {badge && <ConnectionBadge label={badge.label} tone={badge.tone} />}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPaused((current) => !current)}
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
            <Button variant="cta" size="cta" onClick={handleConnect} className="min-w-[88px]">
              <Plug className="h-3.5 w-3.5" /> Connect
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

          <MqttMessagesPanel
            connection={connection}
            messageFilter={messageFilter}
            msgPerSec={msgPerSec}
            onClearMessages={() => clearMessages(connection.id)}
            onMessageFilterChange={setMessageFilter}
            onSearchQueryChange={setSearchQuery}
            onSelectMessage={handleSelectMessage}
            paused={paused}
            rapidStream={rapidStream}
            searchQuery={searchQuery}
            selectedMessage={selectedMessage}
            selectedMessageId={selectedMessageId}
            visibleMessages={visibleMessages}
          />

          <TabsContent value="publish" className="flex-1 overflow-auto m-0">
            <Floater radius="panel" className="p-3 space-y-3">
              <div className="space-y-2">
                <Label className="text-xs sp-label">Topic</Label>
                <Input
                  value={pubTopic}
                  onChange={(event) => setPubTopic(event.target.value)}
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
                    onValueChange={(value) => setPubQos(Number(value) as MqttQoS)}
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
                  onChange={(event) => setPubPayload(event.target.value)}
                  className="font-mono text-xs"
                  rows={8}
                />
              </div>
              <Button onClick={handlePublish} disabled={!isConnected || !pubTopic}>
                <Send className="h-3.5 w-3.5 mr-1.5" /> Publish
              </Button>
            </Floater>
          </TabsContent>

          <MqttSubscriptionsPanel
            isConnected={isConnected}
            onSubscribe={handleSubscribe}
            onUnsubscribe={handleUnsubscribe}
            onSubQosChange={setSubQos}
            onSubTopicChange={setSubTopic}
            subQos={subQos}
            subTopic={subTopic}
            subscriptions={connection.subscriptions}
          />
          <MqttConnectionForm
            connection={connection}
            passwordDraft={passwordDraft}
            passphraseDraft={passphraseDraft}
            onPasswordDraftChange={setPasswordDraft}
            onPassphraseDraftChange={setPassphraseDraft}
            onPickTlsFile={pickTlsFile}
            onUpdateConnection={(patch) => updateConnection(connection.id, patch)}
            onUpdateLwt={(lwt) => updateLwt(connection.id, lwt)}
            onUpdateTls={(tls) => updateTls(connection.id, tls)}
          />
        </Tabs>
      )}
    </div>
  );
}

export default withErrorBoundary(MqttClient);
