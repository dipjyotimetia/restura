import { Pause, Play, Plug, PlugZap, Plus, RefreshCw, Search, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CodeEditorFrame,
  ConnectionBadge,
  Floater,
  ProtoChip,
  Segmented,
  Stat,
  VariableText,
} from '@/components/ui/spatial';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isValidManualOffset } from '@/features/kafka/lib/kafkaConsumerValidation';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import {
  validateJsonPayload,
  validateKafkaHeaders,
  validateOptionalSchemaId,
} from '@/features/kafka/lib/kafkaProducerValidation';
import type { KafkaMessage } from '@/features/kafka/store/useKafkaStore';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { useRapidAppendFlag } from '@/lib/shared/useRapidAppendFlag';
import { cn } from '@/lib/shared/utils';
import type { KafkaGroupInfo } from '../../../../electron/types/electron-api';
import { useKafkaConnection } from '../hooks/useKafkaConnection';
import { KafkaConnectionForm } from './KafkaConnectionForm';
import { KafkaGroupInspector } from './KafkaGroupInspector';
import { KafkaProducerPanel, type ProducePayloadMode } from './KafkaProducerPanel';
import { KafkaTopicInspector } from './KafkaTopicInspector';
import { KAFKA_PINK, partitionColor } from './shared';

type ConsumeMode = 'latest' | 'earliest' | 'from-offset' | 'from-timestamp';

const CONSUME_MODE_OPTIONS = [
  { value: 'latest' as const, label: 'latest' },
  { value: 'earliest' as const, label: 'earliest' },
  { value: 'from-offset' as const, label: 'from-offset' },
  { value: 'from-timestamp' as const, label: 'from-time' },
];

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

function tryFormatJson(value: string): { formatted: string; isJson: boolean } {
  try {
    const parsed = JSON.parse(value);
    return { formatted: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { formatted: value, isJson: false };
  }
}

function DesktopOnlyPanel() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Floater radius="panel" className="max-w-md p-6 text-center space-y-3">
        <h2 className="text-lg font-semibold text-sp-text">Kafka is a desktop-only feature</h2>
        <p className="text-sm text-sp-muted">
          The Kafka client opens raw TCP sockets to your brokers, which the browser cannot do.
          Download the Restura desktop app to publish and consume from Kafka.
        </p>
      </Floater>
    </div>
  );
}

function KafkaClient() {
  const kafkaConnection = useKafkaConnection();
  const {
    isDesktop,
    activeConnectionId,
    connection,
    removeConnection,
    updateConnection,
    updateConsumer,
  } = kafkaConnection;
  const messageFilter = useKafkaStore((s) => s.messageFilter);
  const searchQuery = useKafkaStore((s) => s.searchQuery);
  const clearMessages = useKafkaStore((s) => s.clearMessages);
  const setMessageFilter = useKafkaStore((s) => s.setMessageFilter);
  const setSearchQuery = useKafkaStore((s) => s.setSearchQuery);
  const getFilteredMessages = useKafkaStore((s) => s.getFilteredMessages);
  const [topicDraft, setTopicDraft] = useState('');
  const [produceKey, setProduceKey] = useState('');
  const [produceKeyEncoding, setProduceKeyEncoding] = useState<ProducePayloadMode>('utf8');
  const [produceValue, setProduceValue] = useState('');
  const [produceValueEncoding, setProduceValueEncoding] = useState<ProducePayloadMode>('utf8');
  const [produceHeaders, setProduceHeaders] = useState<
    Array<{ id: string; key: string; value: string; enabled: boolean }>
  >([]);
  const [producePartition, setProducePartition] = useState('');
  // Optional Confluent schema ids (registry connections) — empty = plain.
  const [produceSchemaId, setProduceSchemaId] = useState('');
  const [produceKeySchemaId, setProduceKeySchemaId] = useState('');
  const [produceError, setProduceError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('messages');
  // UI-only — does not affect store/subscription. Visually parks the log.
  const [paused, setPaused] = useState(false);
  // UI-only — informational picker; maps to consumer.fromBeginning where applicable.
  const [consumeMode, setConsumeMode] = useState<ConsumeMode>('latest');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

  // from-offset consume inputs (MANUAL mode). The user must know partition numbers.
  const [offsetPartition, setOffsetPartition] = useState('0');
  const [offsetValue, setOffsetValue] = useState('0');
  // from-timestamp consume input — a datetime-local value resolved to epoch ms.
  const [timestampDraft, setTimestampDraft] = useState('');

  // A valid MANUAL-seek spec: partition is a 0..2^31-1 integer and offset a
  // non-negative integer. Shared by the Subscribe guard and the seek payload so
  // the two can't drift.
  const offsetSpecValid = isValidManualOffset(offsetPartition, offsetValue);

  // Admin tab — transient results (not persisted to the store).
  const [adminTopics, setAdminTopics] = useState<string[] | null>(null);
  const [adminGroups, setAdminGroups] = useState<KafkaGroupInfo[] | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [newTopicName, setNewTopicName] = useState('');
  const [newTopicPartitions, setNewTopicPartitions] = useState('1');
  const [newTopicReplication, setNewTopicReplication] = useState('1');
  // Admin tab — which topic/group is open in its inspector (null = none).
  const [inspectTopicName, setInspectTopicName] = useState<string | null>(null);
  const [inspectGroupId, setInspectGroupId] = useState<string | null>(null);
  const [pendingTopicDelete, setPendingTopicDelete] = useState<string | null>(null);

  // Reset drafts when switching connections
  useEffect(() => {
    setTopicDraft('');
    setProduceKey('');
    setProduceKeyEncoding('utf8');
    setProduceValue('');
    setProduceValueEncoding('utf8');
    setProduceHeaders([]);
    setProducePartition('');
    setProduceError(null);
    setSelectedMessageId(null);
    setPaused(false);
    setTimestampDraft('');
    setAdminTopics(null);
    setAdminGroups(null);
    setAdminError(null);
    setNewTopicName('');
    setInspectTopicName(null);
    setInspectGroupId(null);
  }, [activeConnectionId]);

  // Narrow scalar locals — the underlying `connection` reference can swap on
  // unrelated store updates (e.g. new messages), so hooks depend on the
  // specific primitives/arrays they actually read. Using the same identifiers
  // in body + deps keeps react-hooks/exhaustive-deps happy without widening
  // the trigger set.
  const connectionId = connection?.id;
  const connectionMessages = connection?.messages;
  const fromBeginning = connection?.consumer.fromBeginning;

  // Sync consumeMode <-> fromBeginning (informational pairing)
  useEffect(() => {
    if (connectionId === undefined) return;
    setConsumeMode(fromBeginning ? 'earliest' : 'latest');
  }, [connectionId, fromBeginning]);

  const filteredMessages = useMemo(
    () => (connectionId ? getFilteredMessages(connectionId) : []),
    // `getFilteredMessages` selects from the store using the inputs below;
    // re-running on its identity change isn't needed.
    [connectionId, connectionMessages, messageFilter, searchQuery]
  );

  // Per-partition counts (drives the colored pills strip)
  const partitionCounts = useMemo(() => {
    if (!connectionMessages) return [] as Array<{ partition: number; count: number }>;
    const map = new Map<number, number>();
    for (const m of connectionMessages) {
      if (m.partition === undefined) continue;
      map.set(m.partition, (map.get(m.partition) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([partition, count]) => ({ partition, count }));
  }, [connectionMessages]);

  // Naive msg/sec — counts received messages in the last 5s window.
  const msgPerSec = useMemo(() => {
    if (!connectionMessages) return 0;
    const cutoff = Date.now() - 5_000;
    const recent = connectionMessages.filter(
      (m) => m.direction === 'received' && m.timestamp >= cutoff
    );
    return Math.round((recent.length / 5) * 10) / 10;
  }, [connectionMessages]);

  // Pause is UI-only: we still receive into the store, we just freeze the
  // log view to the snapshot taken when the user clicked Pause.
  const [pausedSnapshot, setPausedSnapshot] = useState<KafkaMessage[] | null>(null);
  useEffect(() => {
    if (paused) {
      setPausedSnapshot(filteredMessages);
    } else {
      setPausedSnapshot(null);
    }
  }, [paused]);
  const visibleMessages = paused && pausedSnapshot ? pausedSnapshot : filteredMessages;

  const selectedMessage: KafkaMessage | null = useMemo(() => {
    if (!connectionMessages || !selectedMessageId) return null;
    return connectionMessages.find((m) => m.id === selectedMessageId) ?? null;
  }, [connectionMessages, selectedMessageId]);

  // Suppresses per-row entry animation while messages arrive faster than ~10/s
  // (consume mode is batch/high-throughput, so this is usually on).
  const rapidStream = useRapidAppendFlag(connectionMessages?.length ?? 0);

  if (!isDesktop) {
    return <DesktopOnlyPanel />;
  }

  const handleProduce = async (): Promise<void> => {
    if (!connection) return;
    if (!produceValue || !connection.defaultTopic) return;
    const valueSchema = connection.registry
      ? validateOptionalSchemaId(produceSchemaId, 'Value')
      : { valid: true as const, value: undefined };
    const keySchema = connection.registry
      ? validateOptionalSchemaId(produceKeySchemaId, 'Key')
      : { valid: true as const, value: undefined };
    if (!valueSchema.valid) {
      setProduceError(valueSchema.error);
      return;
    }
    if (!keySchema.valid) {
      setProduceError(keySchema.error);
      return;
    }
    if (produceValueEncoding === 'json') {
      const json = validateJsonPayload(produceValue, 'Value');
      if (!json.valid) {
        setProduceError(json.error);
        return;
      }
    }
    if (produceKey && produceKeyEncoding === 'json') {
      const json = validateJsonPayload(produceKey, 'Key');
      if (!json.valid) {
        setProduceError(json.error);
        return;
      }
    }
    if (produceValueEncoding === 'base64' && valueSchema.value !== undefined) {
      setProduceError('A Base64 value cannot also use a Schema Registry schema.');
      return;
    }
    if (produceKeyEncoding === 'base64' && keySchema.value !== undefined) {
      setProduceError('A Base64 key cannot also use a Schema Registry schema.');
      return;
    }
    const headers = validateKafkaHeaders(produceHeaders);
    if (!headers.valid) {
      setProduceError(headers.error);
      return;
    }
    const partition = producePartition.trim() ? Number(producePartition) : undefined;
    if (partition !== undefined && (!Number.isSafeInteger(partition) || partition < 0)) {
      setProduceError('Partition must be a non-negative safe integer.');
      return;
    }
    setProduceError(null);
    const result = await kafkaManager.produce({
      connectionId: connection.id,
      topic: connection.defaultTopic,
      ...(produceKey ? { key: produceKey } : {}),
      ...(produceKey ? { keyEncoding: produceKeyEncoding === 'base64' ? 'base64' : 'utf8' } : {}),
      value: produceValue,
      valueEncoding: produceValueEncoding === 'base64' ? 'base64' : 'utf8',
      acks: connection.acks,
      ...(connection.compression !== 'none' ? { compression: connection.compression } : {}),
      ...(Object.keys(headers.value).length > 0 ? { headers: headers.value } : {}),
      ...(partition !== undefined ? { partition } : {}),
      ...(valueSchema.value !== undefined ? { valueSchemaId: valueSchema.value } : {}),
      ...(keySchema.value !== undefined ? { keySchemaId: keySchema.value } : {}),
    });
    if (result.ok) setProduceValue('');
    else setProduceError(result.error);
  };

  const handleSubscribe = async (): Promise<void> => {
    if (!connection) return;
    if (connection.consumer.topics.length === 0) return;
    // 'from-offset' seeks every subscribed topic to (partition, offset) via the
    // MANUAL stream mode. The user supplies one partition/offset pair applied to
    // all subscribed topics — they must know the partition number.
    // 'from-timestamp' resolves each partition's first offset at/after the chosen
    // time (epoch ms) main-side and seeks there.
    const useManual = consumeMode === 'from-offset';
    const useTimestamp = consumeMode === 'from-timestamp';
    const partition = Number(offsetPartition);
    const offsetsValid = useManual && offsetSpecValid;
    // Only send a timestamp once it parses to a real epoch-ms (Subscribe is
    // disabled until then) — never forward "NaN" to the backend.
    const timestampMs = useTimestamp ? new Date(timestampDraft).getTime() : NaN;
    let mode: 'manual' | 'timestamp' | 'earliest' | 'latest';
    if (useManual) mode = 'manual';
    else if (useTimestamp) mode = 'timestamp';
    else mode = connection.consumer.fromBeginning ? 'earliest' : 'latest';
    await kafkaManager.subscribe({
      connectionId: connection.id,
      groupId: connection.consumer.groupId,
      topics: connection.consumer.topics,
      fromBeginning: connection.consumer.fromBeginning,
      mode,
      ...(offsetsValid
        ? {
            offsets: connection.consumer.topics.map((topic) => ({
              topic,
              partition,
              offset: offsetValue.trim(),
            })),
          }
        : {}),
      ...(useTimestamp && !Number.isNaN(timestampMs) ? { timestamp: String(timestampMs) } : {}),
    });
  };

  const handleUnsubscribe = async (): Promise<void> => {
    if (!connection) return;
    await kafkaManager.unsubscribe(connection.id);
  };

  const handleConsumeModeChange = (mode: ConsumeMode): void => {
    setConsumeMode(mode);
    if (!connection) return;
    // earliest <-> fromBeginning; latest <-> !fromBeginning; from-offset is informational
    if (mode === 'earliest' && !connection.consumer.fromBeginning) {
      updateConsumer(connection.id, { fromBeginning: true });
    } else if (mode === 'latest' && connection.consumer.fromBeginning) {
      updateConsumer(connection.id, { fromBeginning: false });
    }
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
  const refreshAdminTopics = async (): Promise<void> => {
    if (!connection) return;
    setAdminBusy(true);
    setAdminError(null);
    const result = await kafkaManager.listTopics(connection.id);
    if (result.ok) setAdminTopics(result.topics.slice().sort());
    else setAdminError(result.error);
    setAdminBusy(false);
  };

  const refreshAdminGroups = async (): Promise<void> => {
    if (!connection) return;
    setAdminBusy(true);
    setAdminError(null);
    const result = await kafkaManager.listGroups(connection.id);
    if (result.ok) setAdminGroups(result.groups);
    else setAdminError(result.error);
    setAdminBusy(false);
  };

  const handleCreateTopic = async (): Promise<void> => {
    if (!connection || !newTopicName.trim()) return;
    setAdminBusy(true);
    setAdminError(null);
    const result = await kafkaManager.createTopic({
      connectionId: connection.id,
      topic: newTopicName.trim(),
      partitions: Math.max(1, Number(newTopicPartitions) || 1),
      replicationFactor: Math.max(1, Number(newTopicReplication) || 1),
    });
    setAdminBusy(false);
    if (!result.ok) {
      setAdminError(result.error);
      return;
    }
    setNewTopicName('');
    await refreshAdminTopics();
  };

  const handleDeleteTopic = async (topic: string): Promise<void> => {
    if (!connection) return;
    setAdminBusy(true);
    setAdminError(null);
    const result = await kafkaManager.deleteTopic(connection.id, topic);
    setAdminBusy(false);
    if (!result.ok) {
      setAdminError(result.error);
      return;
    }
    if (inspectTopicName === topic) setInspectTopicName(null);
    await refreshAdminTopics();
  };

  // In from-offset mode the partition/offset fields must be valid integers,
  // else MANUAL seek can't be built — block Subscribe rather than silently
  // falling back to LATEST.
  const offsetSpecInvalid = consumeMode === 'from-offset' && !offsetSpecValid;
  // from-timestamp needs a parseable time — block Subscribe until one is set.
  // `new Date('')`/unparseable → NaN, so this covers both empty and (defensively,
  // since the datetime-local input already constrains it) malformed values, and
  // guarantees we never send "NaN" to the backend.
  const timestampInvalid =
    consumeMode === 'from-timestamp' && Number.isNaN(new Date(timestampDraft).getTime());

  return (
    <div className="flex flex-1 flex-col overflow-hidden gap-2.5 p-3 bg-transparent">
      <ConfirmDialog
        open={pendingTopicDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTopicDelete(null);
        }}
        title="Delete Kafka topic?"
        description={
          pendingTopicDelete
            ? `This permanently deletes topic "${pendingTopicDelete}" and its retained messages.`
            : ''
        }
        confirmText="Delete topic"
        variant="destructive"
        onConfirm={() => {
          if (!pendingTopicDelete) return;
          const topic = pendingTopicDelete;
          setPendingTopicDelete(null);
          void handleDeleteTopic(topic);
        }}
      />
      {/* Connection bar — pill Floater */}
      <Floater radius="pill" className="flex flex-wrap items-center gap-2 px-3 py-2 shrink-0">
        <ProtoChip protocol="KAFKA" />
        <span className="text-sp-dim font-mono text-sp-12 select-none">›</span>

        {connection && (
          <span className="font-mono text-sp-13 text-sp-text truncate max-w-[200px]">
            <VariableText text={connection.bootstrapBrokers[0] ?? 'no broker'} />
          </span>
        )}

        {connection?.defaultTopic && (
          <>
            <span className="text-sp-dim font-mono text-sp-12 select-none">/</span>
            <span
              className="font-mono text-sp-12 font-medium truncate max-w-[180px]"
              style={{ color: KAFKA_PINK }}
              title={connection.defaultTopic}
            >
              {connection.defaultTopic}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Segmented<ConsumeMode>
            options={CONSUME_MODE_OPTIONS}
            value={consumeMode}
            onChange={handleConsumeModeChange}
            size="sm"
            ariaLabel="Consume mode"
          />

          {connection?.consumer.status === 'subscribed' ? (
            <ConnectionBadge label="Subscribed" tone="success" />
          ) : connection?.consumer.status === 'subscribing' ? (
            <ConnectionBadge label="Subscribing" tone="warning" />
          ) : connection?.consumer.status === 'error' ? (
            <ConnectionBadge label="Error" tone="danger" />
          ) : (
            <ConnectionBadge label="Idle" tone="neutral" />
          )}

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

          {connection && connection.status !== 'connected' && (
            <Button
              variant="cta"
              size="cta"
              onClick={kafkaConnection.connect}
              className="min-w-[88px]"
            >
              <Plug className="h-3.5 w-3.5" /> Connect
            </Button>
          )}
          {connection && connection.status === 'connected' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={kafkaConnection.disconnect}
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
          No connection — click + to create one.
        </Floater>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 flex flex-col min-h-0 gap-3"
        >
          <TabsList className="w-fit shrink-0">
            <TabsTrigger value="messages">Messages ({connection.messages.length})</TabsTrigger>
            <TabsTrigger value="produce">Produce</TabsTrigger>
            <TabsTrigger value="consume">Consume</TabsTrigger>
            <TabsTrigger value="admin">Admin</TabsTrigger>
            <TabsTrigger value="connection">Connection</TabsTrigger>
          </TabsList>

          {/* Messages tab — the redesigned hero view */}
          <TabsContent value="messages" className="flex-1 flex flex-col min-h-0 gap-3 m-0">
            {/* Stats row */}
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
                        partitionCounts.length === 0
                          ? 'var(--color-success)'
                          : 'var(--color-warning)',
                    }}
                  >
                    {/* No real lag wire — use 0 when not subscribed, else "n/a" */}
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

            {/* Two columns: message log + detail panel */}
            <div
              className="flex-1 min-h-0 grid gap-2.5"
              style={{ gridTemplateColumns: '1.6fr 1fr' }}
            >
              {/* Message log */}
              <Floater radius="panel" className="flex flex-col min-h-0 overflow-hidden">
                {/* Toolbar */}
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
                      <SelectItem value="sent">Sent</SelectItem>
                      <SelectItem value="received">Received</SelectItem>
                      <SelectItem value="system">System</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative flex-1">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-sp-dim" />
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
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

                {/* Header row */}
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
                    {visibleMessages.map((m) => {
                      const selected = m.id === selectedMessageId;
                      return (
                        <li
                          key={m.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedMessageId(m.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedMessageId(m.id);
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
                            {m.partition !== undefined ? (
                              <PartitionMiniPill partition={m.partition} />
                            ) : (
                              <span className="text-sp-dim">—</span>
                            )}
                          </div>
                          <span className="text-sp-muted tabular-nums truncate">
                            {m.offset ?? '—'}
                          </span>
                          <span className="text-sp-dim tabular-nums">
                            {new Date(m.timestamp).toLocaleTimeString()}
                          </span>
                          <span className="text-sp-muted truncate" title={m.key ?? ''}>
                            {m.key ?? <span className="text-sp-dim">—</span>}
                          </span>
                          <span
                            className={cn('truncate', m.error ? 'text-red-400' : 'text-sp-text')}
                            title={m.value}
                          >
                            {m.error ? m.error : m.value}
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

              {/* Detail panel */}
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
                          {selectedMessage.headers &&
                          Object.keys(selectedMessage.headers).length > 0 ? (
                            <div
                              className="grid gap-x-3 gap-y-1 font-mono text-sp-11-5"
                              style={{ gridTemplateColumns: 'auto 1fr' }}
                            >
                              {Object.entries(selectedMessage.headers).map(([k, v]) => (
                                <div key={k} className="contents">
                                  <span className="text-sp-muted">{k}</span>
                                  <span className="text-sp-text break-all">{v}</span>
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
                            const { formatted } = tryFormatJson(selectedMessage.value);
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

          <KafkaConnectionForm connection={connection} controller={kafkaConnection} />

          {/* Produce tab */}
          <KafkaProducerPanel
            connection={connection}
            updateConnection={updateConnection}
            produceKey={produceKey}
            setProduceKey={setProduceKey}
            produceKeyEncoding={produceKeyEncoding}
            setProduceKeyEncoding={setProduceKeyEncoding}
            produceValue={produceValue}
            setProduceValue={setProduceValue}
            produceValueEncoding={produceValueEncoding}
            setProduceValueEncoding={setProduceValueEncoding}
            produceHeaders={produceHeaders}
            setProduceHeaders={setProduceHeaders}
            producePartition={producePartition}
            setProducePartition={setProducePartition}
            produceSchemaId={produceSchemaId}
            setProduceSchemaId={setProduceSchemaId}
            produceKeySchemaId={produceKeySchemaId}
            setProduceKeySchemaId={setProduceKeySchemaId}
            produceError={produceError}
            onPublish={handleProduce}
          />

          {/* Consume tab */}
          <TabsContent value="consume" className="flex-1 overflow-auto m-0">
            <Floater radius="panel" className="p-3 space-y-3">
              <div className="space-y-2">
                <Label className="text-xs sp-label">Consumer group ID</Label>
                <Input
                  value={connection.consumer.groupId}
                  onChange={(e) => updateConsumer(connection.id, { groupId: e.target.value })}
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs sp-label">Topics</Label>
                <div className="flex flex-wrap gap-1">
                  {connection.consumer.topics.map((t, idx) => (
                    <Badge
                      key={`${t}-${idx}`}
                      variant="secondary"
                      className="gap-1 font-mono"
                      style={{ color: KAFKA_PINK }}
                    >
                      {t}
                      <button
                        onClick={() => handleRemoveTopic(idx)}
                        aria-label={`Remove topic ${t}`}
                      >
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
                    className="h-8 text-xs font-mono"
                  />
                  <Button size="sm" variant="secondary" onClick={handleAddTopic}>
                    Add
                  </Button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={connection.consumer.fromBeginning}
                  onCheckedChange={(checked) =>
                    updateConsumer(connection.id, { fromBeginning: checked })
                  }
                  disabled={consumeMode === 'from-offset' || consumeMode === 'from-timestamp'}
                />
                <Label className="text-xs">Read from beginning (EARLIEST)</Label>
              </div>

              <div className="space-y-2">
                <Label className="text-xs sp-label">Start mode</Label>
                <Segmented<ConsumeMode>
                  options={CONSUME_MODE_OPTIONS}
                  value={consumeMode}
                  onChange={handleConsumeModeChange}
                  size="sm"
                  ariaLabel="Consume start mode"
                />
                {consumeMode === 'from-offset' && (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div className="space-y-1">
                      <Label className="text-xs sp-label">Partition</Label>
                      <Input
                        value={offsetPartition}
                        onChange={(e) => setOffsetPartition(e.target.value)}
                        inputMode="numeric"
                        placeholder="0"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs sp-label">Offset</Label>
                      <Input
                        value={offsetValue}
                        onChange={(e) => setOffsetValue(e.target.value)}
                        inputMode="numeric"
                        placeholder="0"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <p className="col-span-2 text-sp-11 text-sp-dim">
                      Seeks every subscribed topic to this (partition, offset) via MANUAL mode.
                    </p>
                  </div>
                )}
                {consumeMode === 'from-timestamp' && (
                  <div className="space-y-1 pt-1">
                    <Label className="text-xs sp-label">Start time</Label>
                    <Input
                      type="datetime-local"
                      value={timestampDraft}
                      onChange={(e) => setTimestampDraft(e.target.value)}
                      className="h-8 text-xs font-mono"
                    />
                    <p className="text-sp-11 text-sp-dim">
                      Seeks each partition to its first message at or after this time.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                {connection.consumer.status !== 'subscribed' ? (
                  <Button
                    onClick={handleSubscribe}
                    disabled={
                      connection.status !== 'connected' ||
                      connection.consumer.topics.length === 0 ||
                      offsetSpecInvalid ||
                      timestampInvalid
                    }
                  >
                    Subscribe
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={handleUnsubscribe}>
                    Unsubscribe
                  </Button>
                )}
                <Badge variant="outline" className="font-mono">
                  {connection.consumer.status}
                </Badge>
              </div>
            </Floater>
          </TabsContent>

          {/* Admin tab — topic + consumer-group management */}
          <TabsContent value="admin" className="flex-1 overflow-auto m-0">
            <Floater radius="panel" className="p-3 space-y-4">
              {connection.status !== 'connected' && (
                <p className="text-xs text-sp-muted">Connect to manage topics and groups.</p>
              )}
              {adminError && (
                <div className="font-mono text-sp-12 text-red-400 break-all">{adminError}</div>
              )}

              {/* Create topic */}
              <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
                <Label className="text-xs sp-label">Create topic</Label>
                <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                  <Input
                    value={newTopicName}
                    onChange={(e) => setNewTopicName(e.target.value)}
                    placeholder="topic-name"
                    className="h-8 text-xs font-mono"
                  />
                  <Input
                    value={newTopicPartitions}
                    onChange={(e) => setNewTopicPartitions(e.target.value)}
                    inputMode="numeric"
                    title="Partitions"
                    className="h-8 w-20 text-xs font-mono"
                  />
                  <Input
                    value={newTopicReplication}
                    onChange={(e) => setNewTopicReplication(e.target.value)}
                    inputMode="numeric"
                    title="Replication factor"
                    className="h-8 w-20 text-xs font-mono"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sp-11 text-sp-dim">name · partitions · replication</span>
                  <Button
                    size="sm"
                    onClick={handleCreateTopic}
                    disabled={
                      connection.status !== 'connected' || adminBusy || !newTopicName.trim()
                    }
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" /> Create
                  </Button>
                </div>
              </div>

              {/* Topics list */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs sp-label">Topics</Label>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={refreshAdminTopics}
                    disabled={connection.status !== 'connected' || adminBusy}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> List topics
                  </Button>
                </div>
                {adminTopics === null ? (
                  <p className="text-xs text-sp-dim">Click "List topics" to load.</p>
                ) : adminTopics.length === 0 ? (
                  <p className="text-xs text-sp-dim">No topics.</p>
                ) : (
                  <ul className="space-y-1">
                    {adminTopics.map((t) => (
                      <li
                        key={t}
                        className="flex items-center justify-between rounded-sp-btn border border-sp-line px-2.5 py-1.5"
                      >
                        <span
                          className="font-mono text-sp-12 truncate"
                          style={{ color: KAFKA_PINK }}
                          title={t}
                        >
                          {t}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setInspectTopicName((cur) => (cur === t ? null : t))}
                          disabled={connection.status !== 'connected'}
                          className="h-6 w-6 p-0 ml-auto"
                          title={`Inspect topic ${t}`}
                          aria-label={`Inspect topic ${t}`}
                        >
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPendingTopicDelete(t)}
                          disabled={adminBusy}
                          className="h-6 w-6 p-0"
                          title={`Delete topic ${t}`}
                          aria-label={`Delete topic ${t}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {inspectTopicName !== null && (
                  <KafkaTopicInspector
                    connectionId={connection.id}
                    topic={inspectTopicName}
                    onClose={() => setInspectTopicName(null)}
                  />
                )}
              </div>

              {/* Consumer groups list */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs sp-label">Consumer groups</Label>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={refreshAdminGroups}
                    disabled={connection.status !== 'connected' || adminBusy}
                  >
                    <Users className="h-3.5 w-3.5 mr-1.5" /> List groups
                  </Button>
                </div>
                {adminGroups === null ? (
                  <p className="text-xs text-sp-dim">Click "List groups" to load.</p>
                ) : adminGroups.length === 0 ? (
                  <p className="text-xs text-sp-dim">No consumer groups.</p>
                ) : (
                  <ul className="space-y-1">
                    {adminGroups.map((g) => (
                      <li
                        key={g.id}
                        className="flex items-center gap-2 rounded-sp-btn border border-sp-line px-2.5 py-1.5"
                      >
                        <span className="font-mono text-sp-12 text-sp-text truncate" title={g.id}>
                          {g.id}
                        </span>
                        <Badge variant="outline" className="ml-auto font-mono text-sp-11">
                          {g.state}
                        </Badge>
                        {g.protocolType && (
                          <Badge variant="secondary" className="font-mono text-sp-11">
                            {g.protocolType}
                          </Badge>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setInspectGroupId((cur) => (cur === g.id ? null : g.id))}
                          disabled={connection.status !== 'connected'}
                          className="h-6 w-6 p-0"
                          title={`Inspect group ${g.id}`}
                          aria-label={`Inspect group ${g.id}`}
                        >
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {inspectGroupId !== null && (
                  <KafkaGroupInspector
                    connectionId={connection.id}
                    groupId={inspectGroupId}
                    onClose={() => setInspectGroupId(null)}
                    onDeleted={() => {
                      setInspectGroupId(null);
                      void refreshAdminGroups();
                    }}
                  />
                )}
              </div>
            </Floater>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

export default withErrorBoundary(KafkaClient);
