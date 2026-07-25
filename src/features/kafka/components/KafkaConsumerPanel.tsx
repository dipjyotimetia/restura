import { Trash2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Floater, Segmented } from '@/components/ui/spatial';
import { Switch } from '@/components/ui/switch';
import { TabsContent } from '@/components/ui/tabs';
import type { KafkaConnection, KafkaConsumerState } from '@/features/kafka/store/useKafkaStore';
import { KAFKA_PINK } from './shared';

export type ConsumeMode = 'latest' | 'earliest' | 'from-offset' | 'from-timestamp';

export const CONSUME_MODE_OPTIONS = [
  { value: 'latest' as const, label: 'latest' },
  { value: 'earliest' as const, label: 'earliest' },
  { value: 'from-offset' as const, label: 'from-offset' },
  { value: 'from-timestamp' as const, label: 'from-time' },
];

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
}: KafkaConsumerPanelProps) {
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
        <div className="flex items-center gap-2">
          <Switch
            checked={connection.consumer.fromBeginning}
            onCheckedChange={(checked) => updateConsumer(connection.id, { fromBeginning: checked })}
            disabled={consumeMode === 'from-offset' || consumeMode === 'from-timestamp'}
          />
          <Label className="text-xs">Read from beginning (EARLIEST)</Label>
        </div>
        <div className="space-y-2">
          <Label className="text-xs sp-label">Start mode</Label>
          <Segmented<ConsumeMode>
            options={CONSUME_MODE_OPTIONS}
            value={consumeMode}
            onChange={onConsumeModeChange}
            size="sm"
            ariaLabel="Consume start mode"
          />
          {consumeMode === 'from-offset' && (
            <div className="grid grid-cols-2 gap-2 pt-1">
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
                onChange={(event) => setTimestampDraft(event.target.value)}
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
            <Button variant="secondary" onClick={onUnsubscribe}>
              Unsubscribe
            </Button>
          )}
          <Badge variant="outline" className="font-mono">
            {connection.consumer.status}
          </Badge>
        </div>
      </Floater>
    </TabsContent>
  );
}
