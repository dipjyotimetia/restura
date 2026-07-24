import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Floater } from '@/components/ui/spatial';
import { TabsContent } from '@/components/ui/tabs';
import type { MqttQoS, MqttSubscription } from '@/features/mqtt/store/useMqttStore';
import { MQTT_GREEN, QosPill, QosSelect } from './mqttUi';

interface MqttSubscriptionsPanelProps {
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
