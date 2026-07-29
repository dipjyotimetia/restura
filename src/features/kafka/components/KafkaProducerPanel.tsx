import { Send } from 'lucide-react';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
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
import { Floater } from '@/components/ui/spatial';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import type {
  KafkaAcks,
  KafkaCompression,
  KafkaConnection,
  KafkaPayloadEncoding,
} from '@/features/kafka/store/useKafkaStore';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { getElectronAPI } from '@/lib/shared/platform';
import type { KeyValue } from '@/types';
import type { KafkaRecordIpc } from '../../../../electron/types/electron-api';
import { KAFKA_PINK } from './shared';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-[200px]" />
);

export type ProducePayloadMode = KafkaPayloadEncoding | 'json';
type ProducerMode = 'single' | 'batch' | 'stream' | 'transaction';

const COMPRESSION: KafkaCompression[] = ['none', 'gzip', 'snappy', 'lz4', 'zstd'];

interface KafkaProducerPanelProps {
  connection: KafkaConnection;
  updateConnection: (id: string, patch: Partial<KafkaConnection>) => void;
  produceKey: string;
  setProduceKey: Dispatch<SetStateAction<string>>;
  produceKeyEncoding: ProducePayloadMode;
  setProduceKeyEncoding: Dispatch<SetStateAction<ProducePayloadMode>>;
  produceValue: string;
  setProduceValue: Dispatch<SetStateAction<string>>;
  produceValueEncoding: ProducePayloadMode;
  setProduceValueEncoding: Dispatch<SetStateAction<ProducePayloadMode>>;
  produceHeaders: KeyValue[];
  setProduceHeaders: Dispatch<SetStateAction<KeyValue[]>>;
  producePartition: string;
  setProducePartition: Dispatch<SetStateAction<string>>;
  produceSchemaId: string;
  setProduceSchemaId: Dispatch<SetStateAction<string>>;
  produceKeySchemaId: string;
  setProduceKeySchemaId: Dispatch<SetStateAction<string>>;
  produceError: string | null;
  produceTombstone: boolean;
  setProduceTombstone: Dispatch<SetStateAction<boolean>>;
  onPublish: () => void;
}

function payloadPlaceholder(mode: ProducePayloadMode): string | undefined {
  if (mode === 'base64') return 'Canonical Base64';
  if (mode === 'json') return 'Valid JSON';
  return undefined;
}

function PayloadModeSelect({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string;
  value: ProducePayloadMode;
  onChange: (value: ProducePayloadMode) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ProducePayloadMode)}>
      <SelectTrigger aria-label={ariaLabel} className="h-7 w-32 text-xs font-mono">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="utf8">UTF-8 text</SelectItem>
        <SelectItem value="json">JSON</SelectItem>
        <SelectItem value="base64">Base64 bytes</SelectItem>
      </SelectContent>
    </Select>
  );
}

function TypedRecordBatchEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs sp-label">Typed record array</Label>
      <CodeEditor
        ariaLabel="Kafka typed record batch"
        value={value}
        onChange={onChange}
        language="json"
        height="200px"
        showCopyButton={false}
        formatOnMount={false}
      />
      <p className="text-sp-11 text-sp-dim">
        JSON array of typed records. Monaco highlights malformed JSON before it reaches Kafka.
      </p>
    </div>
  );
}

/** Producer controls kept separate from the connection/message controller. */
export function KafkaProducerPanel({
  connection,
  updateConnection,
  produceKey,
  setProduceKey,
  produceKeyEncoding,
  setProduceKeyEncoding,
  produceValue,
  setProduceValue,
  produceValueEncoding,
  setProduceValueEncoding,
  produceHeaders,
  setProduceHeaders,
  producePartition,
  setProducePartition,
  produceSchemaId,
  setProduceSchemaId,
  produceKeySchemaId,
  setProduceKeySchemaId,
  produceError,
  produceTombstone,
  setProduceTombstone,
  onPublish,
}: KafkaProducerPanelProps) {
  const [mode, setMode] = useState<ProducerMode>('single');
  const [batchJson, setBatchJson] = useState('[]');
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [streamOpen, setStreamOpen] = useState(false);
  const [transactionActive, setTransactionActive] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const api = getElectronAPI()?.kafka;
  const parseRecords = (): KafkaRecordIpc[] => {
    const parsed = JSON.parse(batchJson) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Batch JSON must be an array of typed records.');
    return parsed as KafkaRecordIpc[];
  };
  const run = async (operation: () => Promise<{ success: boolean; error?: string }>) => {
    setSessionBusy(true);
    try {
      const result = await operation();
      setSessionMessage(
        result.success ? 'Operation completed.' : (result.error ?? 'Operation failed.')
      );
      return result.success;
    } catch (error) {
      setSessionMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSessionBusy(false);
    }
  };
  return (
    <TabsContent value="produce" className="flex-1 overflow-auto m-0">
      <Floater radius="panel" className="p-3 space-y-3">
        <div className="space-y-2">
          <Label className="text-xs sp-label">Topic</Label>
          <Input
            value={connection.defaultTopic}
            onChange={(e) => updateConnection(connection.id, { defaultTopic: e.target.value })}
            placeholder="my-topic"
            className="h-8 text-xs font-mono"
            style={{ color: connection.defaultTopic ? KAFKA_PINK : undefined }}
          />
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-xs sp-label">Acks</Label>
            <Select
              value={connection.idempotent ? '-1' : String(connection.acks)}
              onValueChange={(value) =>
                updateConnection(connection.id, { acks: Number(value) as KafkaAcks })
              }
              disabled={connection.idempotent}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0 — fire &amp; forget</SelectItem>
                <SelectItem value="1">1 — leader</SelectItem>
                <SelectItem value="-1">-1 — all in-sync replicas</SelectItem>
              </SelectContent>
            </Select>
            {connection.idempotent && (
              <p className="text-sp-11 text-sp-dim">Locked to -1 by idempotent mode.</p>
            )}
          </div>
          <div className="space-y-2">
            <Label className="text-xs sp-label">Compression</Label>
            <Select
              value={connection.compression}
              onValueChange={(value) =>
                updateConnection(connection.id, { compression: value as KafkaCompression })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPRESSION.map((compression) => (
                  <SelectItem key={compression} value={compression}>
                    {compression}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-start gap-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
          <Switch
            checked={connection.idempotent}
            onCheckedChange={(checked) => updateConnection(connection.id, { idempotent: checked })}
          />
          <div className="space-y-0.5">
            <Label className="text-xs">Idempotent producer</Label>
            <p className="text-sp-11 text-sp-dim">
              Exactly-once-per-partition dedup; forces acks=-1. Reconnect to apply.
            </p>
          </div>
        </div>
        <Tabs value={mode} onValueChange={(value) => setMode(value as ProducerMode)}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="single">Single record</TabsTrigger>
            <TabsTrigger value="batch">Batch</TabsTrigger>
            <TabsTrigger value="stream">Stream</TabsTrigger>
            <TabsTrigger value="transaction">Transaction</TabsTrigger>
          </TabsList>
          <TabsContent value="single" className="mt-3 space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs sp-label">Key (optional)</Label>
                <PayloadModeSelect
                  ariaLabel="Key payload format"
                  value={produceKeyEncoding}
                  onChange={setProduceKeyEncoding}
                />
              </div>
              <Input
                aria-label="Kafka message key"
                value={produceKey}
                onChange={(e) => setProduceKey(e.target.value)}
                placeholder={payloadPlaceholder(produceKeyEncoding)}
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs sp-label">Partition (optional)</Label>
              <Input
                aria-label="Kafka partition"
                value={producePartition}
                onChange={(e) => setProducePartition(e.target.value)}
                inputMode="numeric"
                placeholder="Broker-selected when blank"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs sp-label">Headers</Label>
              <KeyValueEditor
                items={produceHeaders}
                itemType="Kafka header"
                keyPlaceholder="Header name"
                valuePlaceholder="Header value"
                addButtonText="Add header"
                onAdd={() =>
                  setProduceHeaders((headers) => [
                    ...headers,
                    { id: crypto.randomUUID(), key: '', value: '', enabled: true },
                  ])
                }
                onUpdate={(id, patch) =>
                  setProduceHeaders((headers) =>
                    headers.map((header) => (header.id === id ? { ...header, ...patch } : header))
                  )
                }
                onDelete={(id) =>
                  setProduceHeaders((headers) => headers.filter((header) => header.id !== id))
                }
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs sp-label">Value</Label>
                <PayloadModeSelect
                  ariaLabel="Value payload format"
                  value={produceValueEncoding}
                  onChange={setProduceValueEncoding}
                />
              </div>
              {produceValueEncoding === 'json' && !produceTombstone ? (
                <CodeEditor
                  ariaLabel="Kafka message value"
                  value={produceValue}
                  onChange={setProduceValue}
                  language="json"
                  height="220px"
                  showCopyButton={false}
                  formatOnMount={false}
                />
              ) : (
                <Textarea
                  aria-label="Kafka message value"
                  value={produceValue}
                  onChange={(e) => setProduceValue(e.target.value)}
                  disabled={produceTombstone}
                  placeholder={payloadPlaceholder(produceValueEncoding)}
                  className="font-mono text-xs"
                  rows={8}
                />
              )}
              <div className="flex items-center gap-2">
                <Switch
                  id="kafka-produce-tombstone"
                  aria-label="Tombstone (Kafka null value)"
                  checked={produceTombstone}
                  onCheckedChange={setProduceTombstone}
                />
                <Label htmlFor="kafka-produce-tombstone" className="text-xs">
                  Tombstone (Kafka null value)
                </Label>
              </div>
              {produceTombstone && (
                <p className="text-sp-11 text-sp-muted">
                  Kafka receives a null value; compacted topics commonly treat this as a delete
                  marker.
                </p>
              )}
              {produceValueEncoding === 'base64' && (
                <p className="text-sp-11 text-sp-muted">
                  Sent as exact decoded bytes. Whitespace, URL-safe Base64, and malformed padding
                  are rejected.
                </p>
              )}
              {produceValueEncoding === 'json' && (
                <p className="text-sp-11 text-sp-muted">
                  Validated locally, then sent as the exact UTF-8 text you entered.
                </p>
              )}
            </div>
            {connection.registry &&
              [
                {
                  label: 'Value schema ID (optional)',
                  value: produceSchemaId,
                  onChange: setProduceSchemaId,
                  placeholder: 'e.g. 1 — encode the value with this registry schema',
                  encodedHint:
                    'Value is parsed as JSON and Confluent-encoded with this schema (decoded on consume).',
                  plainHint: 'No schema ID — the value is sent as a plain string.',
                },
                {
                  label: 'Key schema ID (optional)',
                  value: produceKeySchemaId,
                  onChange: setProduceKeySchemaId,
                  placeholder: 'e.g. 2 — encode the key with this registry schema',
                  encodedHint:
                    'Key is parsed as JSON and Confluent-encoded with this schema (requires a key; decoded on consume).',
                  plainHint: 'No schema ID — the key is sent as a plain string.',
                },
              ].map((field) => (
                <div key={field.label} className="space-y-2">
                  <Label className="text-xs sp-label">{field.label}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={field.value}
                    onChange={(e) => field.onChange(e.target.value)}
                    placeholder={field.placeholder}
                    className="h-8 text-xs font-mono"
                  />
                  <p className="text-sp-11 text-sp-muted">
                    {field.value.trim() ? field.encodedHint : field.plainHint}
                  </p>
                </div>
              ))}
            {produceError && <p className="text-xs text-red-400">{produceError}</p>}
            <Button
              onClick={onPublish}
              disabled={connection.status !== 'connected' || !connection.defaultTopic}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" /> Publish
            </Button>
          </TabsContent>
          <TabsContent value="batch" className="mt-3 space-y-3">
            <TypedRecordBatchEditor value={batchJson} onChange={setBatchJson} />
            <Button
              size="sm"
              variant="secondary"
              disabled={!api || connection.status !== 'connected' || sessionBusy}
              onClick={() =>
                void run(() =>
                  api!.produceBatch({
                    connectionId: connection.id,
                    records: parseRecords(),
                    acks: connection.acks,
                    compression: connection.compression,
                  })
                )
              }
            >
              Publish batch
            </Button>
          </TabsContent>
          <TabsContent value="stream" className="mt-3 space-y-3">
            <TypedRecordBatchEditor value={batchJson} onChange={setBatchJson} />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!api || transactionActive || sessionBusy}
                onClick={async () => {
                  if (streamOpen) {
                    if (
                      await run(() => api!.closeProducerStream({ connectionId: connection.id }))
                    ) {
                      setStreamOpen(false);
                    }
                  } else if (
                    await run(() =>
                      api!.openProducerStream({
                        connectionId: connection.id,
                        acks: connection.acks,
                        compression: connection.compression,
                        batchSize: 100,
                        batchTime: 250,
                      })
                    )
                  ) {
                    setStreamOpen(true);
                  }
                }}
              >
                {streamOpen ? 'Close stream' : 'Open stream'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!api || !streamOpen || sessionBusy}
                onClick={() =>
                  void run(async () => {
                    for (const record of parseRecords()) {
                      const result = await api!.writeProducerStream({
                        connectionId: connection.id,
                        record,
                      });
                      if (!result.success) return result;
                    }
                    return { success: true };
                  })
                }
              >
                Write batch to stream
              </Button>
            </div>
          </TabsContent>
          <TabsContent value="transaction" className="mt-3 space-y-3">
            <div className="space-y-2">
              <Label className="text-xs sp-label">Transactional ID</Label>
              <Input
                value={connection.transactionalId ?? ''}
                onChange={(event) =>
                  updateConnection(connection.id, {
                    transactionalId: event.target.value || undefined,
                    idempotent: Boolean(event.target.value) || connection.idempotent,
                  })
                }
                placeholder="Stable ID; reconnect to apply"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    !api ||
                    !connection.transactionalId ||
                    streamOpen ||
                    transactionActive ||
                    sessionBusy
                  }
                  onClick={async () => {
                    if (await run(() => api!.beginTransaction({ connectionId: connection.id }))) {
                      setTransactionActive(true);
                    }
                  }}
                >
                  Begin transaction
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!api || !transactionActive || sessionBusy}
                  onClick={() =>
                    void run(() =>
                      api!.produceBatch({
                        connectionId: connection.id,
                        records: parseRecords(),
                        acks: connection.acks,
                        compression: connection.compression,
                      })
                    )
                  }
                >
                  Send batch in transaction
                </Button>
                {(['commit', 'abort'] as const).map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === 'abort' ? 'destructive' : 'secondary'}
                    disabled={!api || !transactionActive || sessionBusy}
                    onClick={async () => {
                      if (
                        await run(() =>
                          api!.endTransaction({ connectionId: connection.id, action })
                        )
                      ) {
                        setTransactionActive(false);
                      }
                    }}
                  >
                    {action === 'commit' ? 'Commit' : 'Abort'}
                  </Button>
                ))}
              </div>
            </div>
            <TypedRecordBatchEditor value={batchJson} onChange={setBatchJson} />
          </TabsContent>
        </Tabs>
        {sessionMessage && (
          <p className="text-sp-11 text-sp-muted" role="status">
            {sessionMessage}
          </p>
        )}
      </Floater>
    </TabsContent>
  );
}
