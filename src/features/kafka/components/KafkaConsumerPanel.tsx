import { Trash2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Floater } from '@/components/ui/spatial';
import { TabsContent } from '@/components/ui/tabs';
import type { KafkaConnection, KafkaConsumerState } from '@/features/kafka/store/useKafkaStore';
import { KAFKA_PINK } from './shared';

export type ConsumeMode = 'committed' | 'latest' | 'earliest' | 'from-offset' | 'from-timestamp';

export const CONSUME_MODE_OPTIONS = [
  { value: 'committed' as const, label: 'Committed offset' },
  { value: 'latest' as const, label: 'Latest messages' },
  { value: 'earliest' as const, label: 'Earliest messages' },
  { value: 'from-offset' as const, label: 'Specific offset' },
  { value: 'from-timestamp' as const, label: 'Timestamp' },
];

const consumerNumericFields = [
  ['sessionTimeoutMs', 'Session timeout (ms)'],
  ['rebalanceTimeoutMs', 'Rebalance timeout (ms)'],
  ['heartbeatIntervalMs', 'Heartbeat interval (ms)'],
  ['autoCommitIntervalMs', 'Auto-commit interval (ms)'],
  ['minBytes', 'Minimum fetch (bytes)'],
  ['maxBytes', 'Maximum fetch (bytes)'],
  ['maxBytesPerPartition', 'Maximum per partition (bytes)'],
  ['maxWaitTimeMs', 'Maximum wait (ms)'],
  ['highWaterMark', 'Stream high-water mark (messages)'],
] as const;

interface KafkaConsumerPanelProps {
  connection: KafkaConnection;
  updateConsumer: (id: string, patch: Partial<KafkaConsumerState>) => void;
  topicDraft: string;
  setTopicDraft: Dispatch<SetStateAction<string>>;
  consumeMode: ConsumeMode;
  onConsumeModeChange: (mode: ConsumeMode) => void;
  offsetPartition: string;
  setOffsetPartition: Dispatch<SetStateAction<string>>;
  offsetValue: string;
  setOffsetValue: Dispatch<SetStateAction<string>>;
  timestampDraft: string;
  setTimestampDraft: Dispatch<SetStateAction<string>>;
  offsetSpecInvalid: boolean;
  timestampInvalid: boolean;
  onAddTopic: () => void;
  onRemoveTopic: (index: number) => void;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
  onPause: () => void;
  onResume: () => void;
  consumerPaused: boolean;
}

/** Subscription configuration and controls kept separate from the shell. */
export function KafkaConsumerPanel({
  connection,
  updateConsumer,
  topicDraft,
  setTopicDraft,
  consumeMode,
  onConsumeModeChange,
  offsetPartition,
  setOffsetPartition,
  offsetValue,
  setOffsetValue,
  timestampDraft,
  setTimestampDraft,
  offsetSpecInvalid,
  timestampInvalid,
  onAddTopic,
  onRemoveTopic,
  onSubscribe,
  onUnsubscribe,
  onPause,
  onResume,
  consumerPaused,
}: KafkaConsumerPanelProps) {
  const subscriptionLabel =
    connection.consumer.status === 'subscribing'
      ? 'Subscribing'
      : connection.consumer.status === 'subscribed'
        ? 'Subscribed'
        : connection.consumer.status === 'error'
          ? 'Error'
          : 'Idle';

  return (
    <TabsContent value="consume" className="flex-1 overflow-auto m-0">
      <Floater radius="panel" className="p-3 space-y-3">
        <div className="space-y-2">
          <Label className="text-xs sp-label">Consumer group ID</Label>
          <Input
            value={connection.consumer.groupId}
            onChange={(event) => updateConsumer(connection.id, { groupId: event.target.value })}
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sp-label">Topics</Label>
          <div className="flex flex-wrap gap-1">
            {connection.consumer.topics.map((topic, index) => (
              <Badge
                key={`${topic}-${index}`}
                variant="secondary"
                className="gap-1 font-mono"
                style={{ color: KAFKA_PINK }}
              >
                {topic}
                <button onClick={() => onRemoveTopic(index)} aria-label={`Remove topic ${topic}`}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={topicDraft}
              onChange={(event) => setTopicDraft(event.target.value)}
              placeholder="topic-name"
              className="h-8 text-xs font-mono"
            />
            <Button size="sm" variant="secondary" onClick={onAddTopic}>
              Add
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="kafka-consume-start-position" className="text-xs sp-label">
            Start position
          </Label>
          <select
            id="kafka-consume-start-position"
            aria-label="Consume start position"
            className="h-8 w-full rounded border border-sp-line bg-sp-surface px-2 text-xs"
            value={consumeMode}
            onChange={(event) => onConsumeModeChange(event.target.value as ConsumeMode)}
          >
            {CONSUME_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {consumeMode === 'from-offset' && (
            <div className="grid grid-cols-1 gap-2 pt-1 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs sp-label">Partition</Label>
                <Input
                  value={offsetPartition}
                  onChange={(event) => setOffsetPartition(event.target.value)}
                  inputMode="numeric"
                  placeholder="0"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs sp-label">Offset</Label>
                <Input
                  value={offsetValue}
                  onChange={(event) => setOffsetValue(event.target.value)}
                  inputMode="numeric"
                  placeholder="0"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <p className="text-sp-11 text-sp-dim md:col-span-2">
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
                onChange={(event) => setTimestampDraft(event.target.value)}
                className="h-8 text-xs font-mono"
              />
              <p className="text-sp-11 text-sp-dim">
                Seeks each partition to its first message at or after this time.
              </p>
            </div>
          )}
        </div>
        <section
          aria-labelledby="kafka-consumer-delivery"
          className="space-y-3 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo"
        >
          <h3 id="kafka-consumer-delivery" className="text-xs font-medium">
            Delivery
          </h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="kafka-consumer-commit-policy" className="text-xs sp-label">
                Commit policy
              </Label>
              <select
                id="kafka-consumer-commit-policy"
                className="h-8 w-full rounded border border-sp-line bg-sp-surface px-2 text-xs"
                value={connection.consumer.commitPolicy}
                onChange={(event) =>
                  updateConsumer(connection.id, {
                    commitPolicy: event.target.value as KafkaConsumerState['commitPolicy'],
                  })
                }
              >
                <option value="auto">Automatic</option>
                <option value="manual">Manual per message</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="kafka-consumer-isolation" className="text-xs sp-label">
                Isolation
              </Label>
              <select
                id="kafka-consumer-isolation"
                className="h-8 w-full rounded border border-sp-line bg-sp-surface px-2 text-xs"
                value={connection.consumer.isolation}
                onChange={(event) =>
                  updateConsumer(connection.id, {
                    isolation: event.target.value as KafkaConsumerState['isolation'],
                  })
                }
              >
                <option value="read-uncommitted">Read uncommitted</option>
                <option value="read-committed">Read committed</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="kafka-consumer-group-protocol" className="text-xs sp-label">
                Group protocol
              </Label>
              <select
                id="kafka-consumer-group-protocol"
                className="h-8 w-full rounded border border-sp-line bg-sp-surface px-2 text-xs"
                value={connection.consumer.groupProtocol}
                onChange={(event) =>
                  updateConsumer(connection.id, {
                    groupProtocol: event.target.value as KafkaConsumerState['groupProtocol'],
                  })
                }
              >
                <option value="classic">Classic</option>
                <option value="consumer">Consumer</option>
              </select>
            </div>
            {consumeMode === 'committed' && (
              <div className="space-y-1">
                <Label htmlFor="kafka-consumer-fallback" className="text-xs sp-label">
                  Missing commit fallback
                </Label>
                <select
                  id="kafka-consumer-fallback"
                  className="h-8 w-full rounded border border-sp-line bg-sp-surface px-2 text-xs"
                  value={connection.consumer.fallbackMode}
                  onChange={(event) =>
                    updateConsumer(connection.id, {
                      fallbackMode: event.target.value as KafkaConsumerState['fallbackMode'],
                    })
                  }
                >
                  <option value="latest">Latest</option>
                  <option value="earliest">Earliest</option>
                  <option value="fail">Fail</option>
                </select>
              </div>
            )}
          </div>
        </section>
        <details className="rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
          <summary className="cursor-pointer text-xs font-medium">Performance tuning</summary>
          <div className="grid grid-cols-1 gap-3 pt-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="kafka-consumer-static-member" className="text-xs sp-label">
                Static member ID
              </Label>
              <Input
                id="kafka-consumer-static-member"
                value={connection.consumer.groupInstanceId ?? ''}
                onChange={(event) =>
                  updateConsumer(connection.id, {
                    groupInstanceId: event.target.value || undefined,
                  })
                }
                placeholder="Optional"
              />
            </div>
            {connection.consumer.groupProtocol === 'consumer' && (
              <div className="space-y-1">
                <Label htmlFor="kafka-consumer-remote-assignor" className="text-xs sp-label">
                  Remote assignor
                </Label>
                <Input
                  id="kafka-consumer-remote-assignor"
                  value={connection.consumer.groupRemoteAssignor ?? ''}
                  onChange={(event) =>
                    updateConsumer(connection.id, {
                      groupRemoteAssignor: event.target.value || undefined,
                    })
                  }
                  placeholder="uniform"
                />
              </div>
            )}
            {consumerNumericFields.map(([field, label]) => (
              <div key={field} className="space-y-1">
                <Label htmlFor={`kafka-consumer-${field}`} className="text-xs sp-label">
                  {label}
                </Label>
                <Input
                  id={`kafka-consumer-${field}`}
                  type="number"
                  min={0}
                  value={connection.consumer[field] ?? ''}
                  placeholder="Client default"
                  disabled={
                    (field === 'heartbeatIntervalMs' &&
                      connection.consumer.groupProtocol === 'consumer') ||
                    (field === 'autoCommitIntervalMs' &&
                      connection.consumer.commitPolicy === 'manual')
                  }
                  onChange={(event) =>
                    updateConsumer(connection.id, {
                      [field]: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </div>
            ))}
            <p className="text-sp-11 text-sp-dim md:col-span-2">
              Blank values use the native Kafka client defaults. Tune these only when your broker
              or workload requires it.
            </p>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-2 border-t border-sp-line pt-3">
          <Badge variant="outline">Subscription: {subscriptionLabel}</Badge>
          <Badge variant="outline">Stream: {consumerPaused ? 'Paused' : 'Running'}</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            {connection.consumer.status !== 'subscribed' ? (
              <Button
                onClick={onSubscribe}
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
              <>
                <Button variant="outline" onClick={consumerPaused ? onResume : onPause}>
                  {consumerPaused ? 'Resume consumer' : 'Pause consumer'}
                </Button>
                <Button variant="secondary" onClick={onUnsubscribe}>
                  Unsubscribe
                </Button>
              </>
            )}
          </div>
        </div>
      </Floater>
    </TabsContent>
  );
}
