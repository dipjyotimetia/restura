import { useEffect, useMemo, useState } from 'react';
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
import { Send, Plus, Trash2, Plug, PlugZap, RefreshCw, Search } from 'lucide-react';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { cn } from '@/lib/shared/utils';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import {
  useKafkaStore,
  KAFKA_SECRET_SENTINEL,
} from '@/features/kafka/store/useKafkaStore';
import type {
  KafkaAuth,
  KafkaAcks,
  KafkaCompression,
  KafkaSecurityProtocol,
  KafkaSaslMechanism,
} from '@/features/kafka/store/useKafkaStore';
import { kafkaManager, kafkaSecretKey } from '@/features/kafka/lib/kafkaManager';
import { secureStorage } from '@/lib/shared/secure-storage';

const SECURITY_PROTOCOLS: KafkaSecurityProtocol[] = ['PLAINTEXT', 'SASL_PLAINTEXT', 'SASL_SSL', 'SSL'];
const SASL_MECHANISMS: KafkaSaslMechanism[] = ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512'];
const COMPRESSION: KafkaCompression[] = ['none', 'gzip', 'snappy', 'lz4', 'zstd'];

function DesktopOnlyPanel() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center space-y-3">
        <h2 className="text-lg font-semibold">Kafka is a desktop-only feature</h2>
        <p className="text-sm text-muted-foreground">
          The Kafka client opens raw TCP sockets to your brokers, which the
          browser cannot do. Download the Restura desktop app to publish and
          consume from Kafka.
        </p>
      </div>
    </div>
  );
}

function KafkaClient() {
  const isDesktop = isElectron();
  const {
    connections,
    activeConnectionId,
    messageFilter,
    searchQuery,
    createConnection,
    removeConnection,
    setActiveConnection,
    updateConnection,
    updateAuth,
    updateConsumer,
    clearMessages,
    setMessageFilter,
    setSearchQuery,
    getFilteredMessages,
  } = useKafkaStore();

  const connection = activeConnectionId ? connections[activeConnectionId] ?? null : null;

  // Ephemeral fields the store deliberately doesn't hold:
  // - new SASL password (until user hits Save → secureStorage)
  // - new TLS passphrase
  // - produce form draft (topic/key/value/headers/partition/acks)
  // - subscribe form draft
  // - new broker / topic input drafts
  const [saslPasswordDraft, setSaslPasswordDraft] = useState('');
  const [tlsPassphraseDraft, setTlsPassphraseDraft] = useState('');
  const [brokerDraft, setBrokerDraft] = useState('');
  const [topicDraft, setTopicDraft] = useState('');
  const [produceKey, setProduceKey] = useState('');
  const [produceValue, setProduceValue] = useState('');
  const [activeTab, setActiveTab] = useState('messages');

  // Reset drafts when switching connections
  useEffect(() => {
    setSaslPasswordDraft('');
    setTlsPassphraseDraft('');
    setBrokerDraft('');
    setTopicDraft('');
    setProduceKey('');
    setProduceValue('');
  }, [activeConnectionId]);

  // Recompute only when the inputs to the filter actually change. Destructuring
  // the store with `useKafkaStore()` returns a fresh `getFilteredMessages`
  // function on every store update, so passing it as a dep would re-run the
  // filter on every inbound consumer message even when nothing relevant
  // changed.
  const filteredMessages = useMemo(
    () => (connection ? getFilteredMessages(connection.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connection?.messages, messageFilter, searchQuery]
  );

  if (!isDesktop) {
    return <DesktopOnlyPanel />;
  }

  const handleCreate = (): void => {
    createConnection({});
  };

  const handleConnect = async (): Promise<void> => {
    if (!connection) return;
    // Stash any draft secrets in secureStorage, then compose both auth
    // mutations into a single updateAuth call. Doing two sequential
    // updateAuth() calls would leave the second one operating on a stale
    // `connection.auth` snapshot.
    let nextAuth = connection.auth;
    if (saslPasswordDraft && nextAuth.sasl) {
      secureStorage.set(kafkaSecretKey(connection.id, 'sasl-password'), saslPasswordDraft);
      nextAuth = {
        ...nextAuth,
        sasl: { ...nextAuth.sasl, password: KAFKA_SECRET_SENTINEL },
      };
      setSaslPasswordDraft('');
    }
    if (tlsPassphraseDraft) {
      secureStorage.set(kafkaSecretKey(connection.id, 'tls-passphrase'), tlsPassphraseDraft);
      nextAuth = {
        ...nextAuth,
        tls: { ...(nextAuth.tls ?? {}), passphrase: KAFKA_SECRET_SENTINEL },
      };
      setTlsPassphraseDraft('');
    }
    if (nextAuth !== connection.auth) {
      updateAuth(connection.id, nextAuth);
    }
    await kafkaManager.connect({ ...connection, auth: nextAuth });
  };

  const handleDisconnect = async (): Promise<void> => {
    if (!connection) return;
    await kafkaManager.disconnect(connection.id);
  };

  const handleProduce = async (): Promise<void> => {
    if (!connection) return;
    if (!produceValue || !connection.defaultTopic) return;
    await kafkaManager.produce({
      connectionId: connection.id,
      topic: connection.defaultTopic,
      ...(produceKey ? { key: produceKey } : {}),
      value: produceValue,
      acks: connection.acks,
      ...(connection.compression !== 'none' ? { compression: connection.compression } : {}),
    });
    setProduceValue('');
  };

  const handleSubscribe = async (): Promise<void> => {
    if (!connection) return;
    if (connection.consumer.topics.length === 0) return;
    await kafkaManager.subscribe({
      connectionId: connection.id,
      groupId: connection.consumer.groupId,
      topics: connection.consumer.topics,
      fromBeginning: connection.consumer.fromBeginning,
    });
  };

  const handleUnsubscribe = async (): Promise<void> => {
    if (!connection) return;
    await kafkaManager.unsubscribe(connection.id);
  };

  const handleAddBroker = (): void => {
    if (!connection || !brokerDraft.trim()) return;
    updateConnection(connection.id, {
      bootstrapBrokers: [...connection.bootstrapBrokers, brokerDraft.trim()],
    });
    setBrokerDraft('');
  };

  const handleRemoveBroker = (idx: number): void => {
    if (!connection) return;
    updateConnection(connection.id, {
      bootstrapBrokers: connection.bootstrapBrokers.filter((_, i) => i !== idx),
    });
  };

  const handleAddTopic = (): void => {
    if (!connection || !topicDraft.trim()) return;
    updateConsumer(connection.id, {
      topics: [...connection.consumer.topics, topicDraft.trim()],
    });
    setTopicDraft('');
  };

  const handleRemoveTopic = (idx: number): void => {
    if (!connection) return;
    updateConsumer(connection.id, {
      topics: connection.consumer.topics.filter((_, i) => i !== idx),
    });
  };

  const pickTlsFile = async (
    field: 'caPath' | 'certPath' | 'keyPath'
  ): Promise<void> => {
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
    updateAuth(connection.id, {
      ...connection.auth,
      tls: { ...(connection.auth.tls ?? {}), [field]: result.filePaths[0] },
    });
  };

  const setSecurityProtocol = (sp: KafkaSecurityProtocol): void => {
    if (!connection) return;
    const next: KafkaAuth = { securityProtocol: sp };
    if (sp === 'SASL_PLAINTEXT' || sp === 'SASL_SSL') {
      next.sasl = connection.auth.sasl ?? { mechanism: 'PLAIN', username: '', password: '' };
    }
    if (sp === 'SASL_SSL' || sp === 'SSL') {
      next.tls = connection.auth.tls ?? {};
    }
    updateAuth(connection.id, next);
  };

  const connList = Object.values(connections).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header: connection picker + status */}
      <div className="flex items-center gap-1 border-y glass-border-subtle glass-3 px-3 h-12 shrink-0">
        <div
          className={cn(
            'flex items-center justify-center px-2 h-7 w-20 font-mono text-[11px] font-bold tracking-wider rounded border shrink-0',
            connection?.status === 'connected'
              ? 'bg-emerald-500/[0.12] border-emerald-500/25 text-emerald-400'
              : 'bg-amber-500/[0.12] border-amber-500/25 text-amber-400'
          )}
          aria-label={`Kafka status: ${connection?.status ?? 'no connection'}`}
        >
          KAFKA
        </div>
        <span className="text-muted-foreground/40 font-mono text-sm select-none shrink-0">›</span>
        <Select
          value={connection?.id ?? ''}
          onValueChange={(v) => setActiveConnection(v || null)}
        >
          <SelectTrigger className="w-64 h-7 text-xs glass-2 glass-border-subtle border">
            <SelectValue placeholder="Select a Kafka connection" />
          </SelectTrigger>
          <SelectContent>
            {connList.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name} · {c.bootstrapBrokers[0] ?? 'no broker'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={handleCreate} title="New connection" className="h-7">
          <Plus className="h-3.5 w-3.5" />
        </Button>
        {connection && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => removeConnection(connection.id)}
            title="Delete connection"
            className="h-7"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {connection && connection.status !== 'connected' && (
            <Button
              variant="glow"
              size="sm"
              onClick={handleConnect}
              className="h-7 min-w-[80px] text-xs font-medium"
            >
              <Plug className="h-3.5 w-3.5 mr-1.5" /> Connect
            </Button>
          )}
          {connection && connection.status === 'connected' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDisconnect}
              className="h-7 min-w-[80px] text-xs font-medium"
            >
              <PlugZap className="h-3.5 w-3.5 mr-1.5" /> Disconnect
            </Button>
          )}
        </div>
      </div>

      {!connection ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No connection — click + to create one.
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-3 mt-2 w-fit">
            <TabsTrigger value="connection">Connection</TabsTrigger>
            <TabsTrigger value="produce">Produce</TabsTrigger>
            <TabsTrigger value="consume">Consume</TabsTrigger>
            <TabsTrigger value="messages">Messages ({connection.messages.length})</TabsTrigger>
          </TabsList>

          {/* Connection tab */}
          <TabsContent value="connection" className="flex-1 overflow-auto px-3 py-2 space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">Connection name</Label>
              <Input
                value={connection.name}
                onChange={(e) => updateConnection(connection.id, { name: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Client ID</Label>
              <Input
                value={connection.clientId}
                onChange={(e) => updateConnection(connection.id, { clientId: e.target.value })}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Bootstrap brokers</Label>
              <div className="flex flex-wrap gap-1">
                {connection.bootstrapBrokers.map((b, idx) => (
                  <Badge key={`${b}-${idx}`} variant="secondary" className="gap-1">
                    {b}
                    <button onClick={() => handleRemoveBroker(idx)} aria-label={`Remove broker ${b}`}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={brokerDraft}
                  onChange={(e) => setBrokerDraft(e.target.value)}
                  placeholder="host:port"
                  className="h-8 text-xs"
                />
                <Button size="sm" variant="secondary" onClick={handleAddBroker}>
                  Add
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Security protocol</Label>
              <Select
                value={connection.auth.securityProtocol}
                onValueChange={(v) => setSecurityProtocol(v as KafkaSecurityProtocol)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SECURITY_PROTOCOLS.map((sp) => (
                    <SelectItem key={sp} value={sp}>{sp}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(connection.auth.securityProtocol === 'SASL_PLAINTEXT' ||
              connection.auth.securityProtocol === 'SASL_SSL') && connection.auth.sasl && (
              <div className="space-y-2 rounded border p-3">
                <Label className="text-xs font-semibold">SASL</Label>
                <Select
                  value={connection.auth.sasl.mechanism}
                  onValueChange={(v) => updateAuth(connection.id, {
                    ...connection.auth,
                    sasl: { ...connection.auth.sasl!, mechanism: v as KafkaSaslMechanism },
                  })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SASL_MECHANISMS.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={connection.auth.sasl.username}
                  onChange={(e) => updateAuth(connection.id, {
                    ...connection.auth,
                    sasl: { ...connection.auth.sasl!, username: e.target.value },
                  })}
                  placeholder="Username"
                  className="h-8 text-xs"
                />
                <Input
                  type="password"
                  value={saslPasswordDraft}
                  onChange={(e) => setSaslPasswordDraft(e.target.value)}
                  placeholder={
                    connection.auth.sasl.password === KAFKA_SECRET_SENTINEL
                      ? 'Password (stored — leave blank to keep)'
                      : 'Password'
                  }
                  className="h-8 text-xs"
                />
              </div>
            )}

            {(connection.auth.securityProtocol === 'SASL_SSL' ||
              connection.auth.securityProtocol === 'SSL') && (
              <div className="space-y-2 rounded border p-3">
                <Label className="text-xs font-semibold">TLS</Label>
                {(['caPath', 'certPath', 'keyPath'] as const).map((field) => (
                  <div key={field} className="flex gap-2">
                    <Input
                      value={connection.auth.tls?.[field] ?? ''}
                      readOnly
                      placeholder={field}
                      className="h-8 text-xs"
                    />
                    <Button size="sm" variant="secondary" onClick={() => pickTlsFile(field)}>
                      Browse
                    </Button>
                  </div>
                ))}
                <Input
                  type="password"
                  value={tlsPassphraseDraft}
                  onChange={(e) => setTlsPassphraseDraft(e.target.value)}
                  placeholder={
                    connection.auth.tls?.passphrase === KAFKA_SECRET_SENTINEL
                      ? 'Key passphrase (stored — leave blank to keep)'
                      : 'Key passphrase (optional)'
                  }
                  className="h-8 text-xs"
                />
                <div className="flex items-center gap-2">
                  <Switch
                    checked={connection.auth.tls?.rejectUnauthorized !== false}
                    onCheckedChange={(checked) => updateAuth(connection.id, {
                      ...connection.auth,
                      tls: { ...(connection.auth.tls ?? {}), rejectUnauthorized: checked },
                    })}
                  />
                  <Label className="text-xs">Verify server certificate</Label>
                </div>
              </div>
            )}
          </TabsContent>

          {/* Produce tab */}
          <TabsContent value="produce" className="flex-1 overflow-auto px-3 py-2 space-y-3">
            <div className="space-y-2">
              <Label className="text-xs">Topic</Label>
              <Input
                value={connection.defaultTopic}
                onChange={(e) => updateConnection(connection.id, { defaultTopic: e.target.value })}
                placeholder="my-topic"
                className="h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label className="text-xs">Acks</Label>
                <Select
                  value={String(connection.acks)}
                  onValueChange={(v) => updateConnection(connection.id, { acks: Number(v) as KafkaAcks })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">0 — fire & forget</SelectItem>
                    <SelectItem value="1">1 — leader</SelectItem>
                    <SelectItem value="-1">-1 — all in-sync replicas</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Compression</Label>
                <Select
                  value={connection.compression}
                  onValueChange={(v) => updateConnection(connection.id, { compression: v as KafkaCompression })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMPRESSION.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Key (optional)</Label>
              <Input
                value={produceKey}
                onChange={(e) => setProduceKey(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Value</Label>
              <Textarea
                value={produceValue}
                onChange={(e) => setProduceValue(e.target.value)}
                className="font-mono text-xs"
                rows={8}
              />
            </div>
            <Button
              onClick={handleProduce}
              disabled={connection.status !== 'connected' || !produceValue || !connection.defaultTopic}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" /> Publish
            </Button>
          </TabsContent>

          {/* Consume tab */}
          <TabsContent value="consume" className="flex-1 overflow-auto px-3 py-2 space-y-3">
            <div className="space-y-2">
              <Label className="text-xs">Consumer group ID</Label>
              <Input
                value={connection.consumer.groupId}
                onChange={(e) => updateConsumer(connection.id, { groupId: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Topics</Label>
              <div className="flex flex-wrap gap-1">
                {connection.consumer.topics.map((t, idx) => (
                  <Badge key={`${t}-${idx}`} variant="secondary" className="gap-1">
                    {t}
                    <button onClick={() => handleRemoveTopic(idx)} aria-label={`Remove topic ${t}`}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={topicDraft}
                  onChange={(e) => setTopicDraft(e.target.value)}
                  placeholder="topic-name"
                  className="h-8 text-xs"
                />
                <Button size="sm" variant="secondary" onClick={handleAddTopic}>
                  Add
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={connection.consumer.fromBeginning}
                onCheckedChange={(checked) => updateConsumer(connection.id, { fromBeginning: checked })}
              />
              <Label className="text-xs">Read from beginning (EARLIEST)</Label>
            </div>
            <div className="flex gap-2">
              {connection.consumer.status !== 'subscribed' ? (
                <Button
                  onClick={handleSubscribe}
                  disabled={connection.status !== 'connected' || connection.consumer.topics.length === 0}
                >
                  Subscribe
                </Button>
              ) : (
                <Button variant="secondary" onClick={handleUnsubscribe}>
                  Unsubscribe
                </Button>
              )}
              <Badge variant="outline">{connection.consumer.status}</Badge>
            </div>
          </TabsContent>

          {/* Messages tab */}
          <TabsContent value="messages" className="flex-1 flex flex-col min-h-0 px-3 py-2">
            <div className="flex items-center gap-2 mb-2">
              <Select value={messageFilter} onValueChange={(v) => setMessageFilter(v as 'sent' | 'received' | 'system' | 'all')}>
                <SelectTrigger className="h-8 w-32 text-xs">
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
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search topic, key, value"
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <Button size="sm" variant="ghost" onClick={() => clearMessages(connection.id)}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <ScrollArea className="flex-1 rounded border">
              <ul className="divide-y text-xs">
                {filteredMessages.map((m) => (
                  <li key={m.id} className="px-3 py-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          m.direction === 'sent'
                            ? 'default'
                            : m.direction === 'received'
                              ? 'secondary'
                              : 'outline'
                        }
                        className="capitalize"
                      >
                        {m.direction}
                      </Badge>
                      {m.topic && <span className="font-mono text-muted-foreground">{m.topic}</span>}
                      {m.partition !== undefined && (
                        <span className="text-muted-foreground">p{m.partition}</span>
                      )}
                      {m.offset && <span className="text-muted-foreground">@{m.offset}</span>}
                      <span className="ml-auto text-muted-foreground">
                        {new Date(m.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    {m.key && <div className="font-mono text-muted-foreground">key: {m.key}</div>}
                    <pre className="font-mono whitespace-pre-wrap break-all">{m.value}</pre>
                    {m.error && <div className="text-destructive">{m.error}</div>}
                  </li>
                ))}
                {filteredMessages.length === 0 && (
                  <li className="px-3 py-6 text-center text-muted-foreground">No messages yet.</li>
                )}
              </ul>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

export default withErrorBoundary(KafkaClient);
