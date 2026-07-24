import { Pause, Play, Plug, PlugZap, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { Button } from '@/components/ui/button';
import {
  Floater,
  ConnectionBadge,
  ProtoChip,
  Segmented,
  VariableText,
} from '@/components/ui/spatial';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isValidManualOffset } from '@/features/kafka/lib/kafkaConsumerValidation';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import {
  validateJsonPayload,
  validateKafkaHeaders,
  validateOptionalSchemaId,
} from '@/features/kafka/lib/kafkaProducerValidation';
import { useKafkaConnection } from '../hooks/useKafkaConnection';
import { KafkaAdminPanel } from './KafkaAdminPanel';
import { KafkaConnectionForm } from './KafkaConnectionForm';
import { KafkaConsumerPanel, CONSUME_MODE_OPTIONS, type ConsumeMode } from './KafkaConsumerPanel';
import { KafkaMessagesPanel } from './KafkaMessagesPanel';
import { KafkaProducerPanel, type ProducePayloadMode } from './KafkaProducerPanel';
import { KAFKA_PINK } from './shared';

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
  const [activeTab, setActiveTab] = useState('messages');
  const [paused, setPaused] = useState(false);
  const [consumeMode, setConsumeMode] = useState<ConsumeMode>('latest');
  const [topicDraft, setTopicDraft] = useState('');
  const [offsetPartition, setOffsetPartition] = useState('0');
  const [offsetValue, setOffsetValue] = useState('0');
  const [timestampDraft, setTimestampDraft] = useState('');
  const [produceKey, setProduceKey] = useState('');
  const [produceKeyEncoding, setProduceKeyEncoding] = useState<ProducePayloadMode>('utf8');
  const [produceValue, setProduceValue] = useState('');
  const [produceValueEncoding, setProduceValueEncoding] = useState<ProducePayloadMode>('utf8');
  const [produceHeaders, setProduceHeaders] = useState<
    Array<{ id: string; key: string; value: string; enabled: boolean }>
  >([]);
  const [producePartition, setProducePartition] = useState('');
  const [produceSchemaId, setProduceSchemaId] = useState('');
  const [produceKeySchemaId, setProduceKeySchemaId] = useState('');
  const [produceError, setProduceError] = useState<string | null>(null);

  useEffect(() => {
    setPaused(false);
    setConsumeMode('latest');
    setTopicDraft('');
    setTimestampDraft('');
    setProduceKey('');
    setProduceKeyEncoding('utf8');
    setProduceValue('');
    setProduceValueEncoding('utf8');
    setProduceHeaders([]);
    setProducePartition('');
    setProduceError(null);
  }, [activeConnectionId]);

  useEffect(() => {
    if (connection) setConsumeMode(connection.consumer.fromBeginning ? 'earliest' : 'latest');
  }, [connection?.id, connection?.consumer.fromBeginning]);

  if (!isDesktop) return <DesktopOnlyPanel />;

  const handleProduce = async (): Promise<void> => {
    if (!connection || !produceValue || !connection.defaultTopic) return;
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
  const handleConsumeModeChange = (mode: ConsumeMode): void => {
    setConsumeMode(mode);
    if (!connection) return;
    if (mode === 'earliest' && !connection.consumer.fromBeginning) {
      updateConsumer(connection.id, { fromBeginning: true });
    } else if (mode === 'latest' && connection.consumer.fromBeginning) {
      updateConsumer(connection.id, { fromBeginning: false });
    }
  };
  const handleSubscribe = async (): Promise<void> => {
    if (!connection || connection.consumer.topics.length === 0) return;
    const useManual = consumeMode === 'from-offset';
    const useTimestamp = consumeMode === 'from-timestamp';
    const offsetsValid = useManual && isValidManualOffset(offsetPartition, offsetValue);
    const timestampMs = useTimestamp ? new Date(timestampDraft).getTime() : NaN;
    const mode = useManual
      ? 'manual'
      : useTimestamp
        ? 'timestamp'
        : connection.consumer.fromBeginning
          ? 'earliest'
          : 'latest';
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
              partition: Number(offsetPartition),
              offset: offsetValue.trim(),
            })),
          }
        : {}),
      ...(useTimestamp && !Number.isNaN(timestampMs) ? { timestamp: String(timestampMs) } : {}),
    });
  };
  const handleAddTopic = (): void => {
    if (!connection || !topicDraft.trim()) return;
    updateConsumer(connection.id, { topics: [...connection.consumer.topics, topicDraft.trim()] });
    setTopicDraft('');
  };
  const handleRemoveTopic = (index: number): void => {
    if (connection) {
      updateConsumer(connection.id, {
        topics: connection.consumer.topics.filter((_, i) => i !== index),
      });
    }
  };
  const offsetSpecInvalid =
    consumeMode === 'from-offset' && !isValidManualOffset(offsetPartition, offsetValue);
  const timestampInvalid =
    consumeMode === 'from-timestamp' && Number.isNaN(new Date(timestampDraft).getTime());

  return (
    <div className="flex flex-1 flex-col overflow-hidden gap-2.5 p-3 bg-transparent">
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
          {connection?.status !== 'connected' && connection && (
            <Button
              variant="cta"
              size="cta"
              onClick={kafkaConnection.connect}
              className="min-w-[88px]"
            >
              <Plug className="h-3.5 w-3.5" /> Connect
            </Button>
          )}
          {connection?.status === 'connected' && (
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
          <KafkaMessagesPanel key={connection.id} connection={connection} paused={paused} />
          <KafkaConnectionForm connection={connection} controller={kafkaConnection} />
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
          <KafkaConsumerPanel
            connection={connection}
            updateConsumer={updateConsumer}
            topicDraft={topicDraft}
            setTopicDraft={setTopicDraft}
            consumeMode={consumeMode}
            onConsumeModeChange={handleConsumeModeChange}
            offsetPartition={offsetPartition}
            setOffsetPartition={setOffsetPartition}
            offsetValue={offsetValue}
            setOffsetValue={setOffsetValue}
            timestampDraft={timestampDraft}
            setTimestampDraft={setTimestampDraft}
            offsetSpecInvalid={offsetSpecInvalid}
            timestampInvalid={timestampInvalid}
            onAddTopic={handleAddTopic}
            onRemoveTopic={handleRemoveTopic}
            onSubscribe={handleSubscribe}
            onUnsubscribe={() => void kafkaManager.unsubscribe(connection.id)}
          />
          <KafkaAdminPanel key={connection.id} connection={connection} />
        </Tabs>
      )}
    </div>
  );
}

export default withErrorBoundary(KafkaClient);
