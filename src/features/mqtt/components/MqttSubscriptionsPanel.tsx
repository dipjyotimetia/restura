import { Trash2 } from 'lucide-react';
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
import { Floater } from '@/components/ui/spatial';
import { Switch } from '@/components/ui/switch';
import { TabsContent } from '@/components/ui/tabs';
import type {
  MqttQoS,
  MqttSubscription,
  MqttSubscriptionOptions,
} from '@/features/mqtt/store/useMqttStore';
import { MQTT_GREEN, QosPill, QosSelect } from './mqttUi';

interface MqttSubscriptionsPanelProps {
  /** MQTT 5 subscription options are only offered on v5 connections. */
  isV5?: boolean;
  subOptions?: MqttSubscriptionOptions;
  onSubOptionsChange?: (options: MqttSubscriptionOptions) => void;
  subIdentifier?: number | undefined;
  onSubIdentifierChange?: (id: number | undefined) => void;
  isConnected: boolean;
  onSubscribe: () => void;
  onUnsubscribe: (topicFilter: string) => void;
  onSubQosChange: (qos: MqttQoS) => void;
  onSubTopicChange: (topic: string) => void;
  subQos: MqttQoS;
  subTopic: string;
  subscriptions: MqttSubscription[];
}

/** Subscribe controls and active-subscription management; manager calls stay in the client shell. */
export function MqttSubscriptionsPanel({
  isV5 = false,
  subOptions = {},
  onSubOptionsChange,
  subIdentifier,
  onSubIdentifierChange,
  isConnected,
  onSubscribe,
  onUnsubscribe,
  onSubQosChange,
  onSubTopicChange,
  subQos,
  subTopic,
  subscriptions,
}: MqttSubscriptionsPanelProps) {
  return (
    <TabsContent value="subscribe" className="flex-1 overflow-auto m-0">
      <Floater radius="panel" className="p-3 space-y-3">
        <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 120px auto' }}>
          <div className="space-y-2">
            <Label className="text-xs sp-label">Topic filter</Label>
            <Input
              value={subTopic}
              onChange={(event) => onSubTopicChange(event.target.value)}
              placeholder="restura/+/temp  or  sensors/#"
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs sp-label">QoS</Label>
            <QosSelect value={subQos} onChange={onSubQosChange} />
          </div>
          <div className="flex items-end">
            <Button onClick={onSubscribe} disabled={!isConnected || !subTopic.trim()}>
              Subscribe
            </Button>
          </div>
        </div>

        {isV5 && onSubOptionsChange && (
          <div className="flex flex-wrap items-end gap-4 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
            <div className="flex items-center gap-2 h-8">
              <Switch
                checked={subOptions.noLocal === true}
                onCheckedChange={(checked) =>
                  onSubOptionsChange({ ...subOptions, noLocal: checked || undefined })
                }
                aria-label="No Local"
              />
              <Label className="text-xs" title="Don't receive messages this client published">
                No Local
              </Label>
            </div>
            <div className="flex items-center gap-2 h-8">
              <Switch
                checked={subOptions.retainAsPublished === true}
                onCheckedChange={(checked) =>
                  onSubOptionsChange({ ...subOptions, retainAsPublished: checked || undefined })
                }
                aria-label="Retain as Published"
              />
              <Label className="text-xs">Retain as Published</Label>
            </div>
            <div className="space-y-1">
              <Label className="text-xs sp-label">Retain handling</Label>
              <Select
                value={String(subOptions.retainHandling ?? 0)}
                onValueChange={(value) =>
                  onSubOptionsChange({
                    ...subOptions,
                    retainHandling: value === '0' ? undefined : (Number(value) as 1 | 2),
                  })
                }
              >
                <SelectTrigger className="h-8 text-xs w-56" aria-label="Retain handling">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0 — send retained on subscribe</SelectItem>
                  <SelectItem value="1">1 — only if new subscription</SelectItem>
                  <SelectItem value="2">2 — never send retained</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs sp-label">Subscription ID</Label>
              <Input
                type="number"
                min={1}
                value={subIdentifier ?? ''}
                onChange={(event) =>
                  onSubIdentifierChange?.(
                    event.target.value ? Number(event.target.value) : undefined
                  )
                }
                placeholder="optional"
                className="h-8 text-xs font-mono w-28"
              />
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-xs sp-label">Active subscriptions</Label>
          {subscriptions.length === 0 ? (
            <div className="text-sp-dim text-sp-11-5 italic">No active subscriptions.</div>
          ) : (
            <ul className="space-y-1">
              {subscriptions.map((subscription) => (
                <li
                  key={subscription.topicFilter}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-sp-btn border border-sp-line bg-sp-surface-lo"
                >
                  <span className="font-mono text-sp-12" style={{ color: MQTT_GREEN }}>
                    {subscription.topicFilter}
                  </span>
                  {subscription.grantedQos !== undefined && (
                    <QosPill qos={subscription.grantedQos} />
                  )}
                  <Badge variant="outline" className="font-mono text-sp-10">
                    {subscription.status}
                    {subscription.subscriptionIdentifier !== undefined
                      ? ` · id ${subscription.subscriptionIdentifier}`
                      : ''}
                    {subscription.options?.noLocal ? ' · no local' : ''}
                  </Badge>
                  <button
                    className="ml-auto text-sp-dim hover:text-red-400"
                    onClick={() => onUnsubscribe(subscription.topicFilter)}
                    aria-label={`Unsubscribe ${subscription.topicFilter}`}
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
  );
}
