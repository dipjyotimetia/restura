import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { MQTT_PAYLOAD_FORMATS, type MqttPayloadFormat } from '@/features/mqtt/lib/mqttPayload';

/** Composer-only publish settings (payload format + MQTT 5 extras + request mode). */
export interface MqttPublishSettings {
  format: MqttPayloadFormat;
  contentType?: string;
  messageExpiryInterval?: number;
  payloadFormatIndicator?: boolean;
  topicAlias?: number;
  responseTopic?: string;
  correlationData?: string;
  /** Request/response timeout (ms) for the Request action. */
  requestTimeoutMs: number;
}

export const DEFAULT_PUBLISH_SETTINGS: MqttPublishSettings = {
  format: 'text',
  requestTimeoutMs: 10_000,
};

interface MqttPublishOptionsProps {
  settings: MqttPublishSettings;
  onChange: (settings: MqttPublishSettings) => void;
  isV5: boolean;
  /** CONNACK Topic Alias Maximum; undefined/0 = the broker accepts none. */
  serverTopicAliasMaximum: number | undefined;
}

function num(value: string): number | undefined {
  return value.trim() === '' || Number.isNaN(Number(value)) ? undefined : Number(value);
}

export function MqttPublishOptions({
  settings,
  onChange,
  isV5,
  serverTopicAliasMaximum,
}: MqttPublishOptionsProps) {
  const patch = (next: Partial<MqttPublishSettings>): void => onChange({ ...settings, ...next });
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label className="text-xs sp-label">Payload format</Label>
        <Select
          value={settings.format}
          onValueChange={(value) => patch({ format: value as MqttPayloadFormat })}
        >
          <SelectTrigger className="h-8 text-xs w-40" aria-label="Payload format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MQTT_PAYLOAD_FORMATS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isV5 && (
        <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
          <Label className="text-xs sp-label">MQTT 5 properties</Label>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Content type</Label>
              <Input
                value={settings.contentType ?? ''}
                onChange={(e) => patch({ contentType: e.target.value || undefined })}
                placeholder="application/json"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Message expiry (s)</Label>
              <Input
                type="number"
                min={0}
                value={settings.messageExpiryInterval ?? ''}
                onChange={(e) => patch({ messageExpiryInterval: num(e.target.value) })}
                placeholder="optional"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Topic alias{serverTopicAliasMaximum ? ` (1–${serverTopicAliasMaximum})` : ''}
              </Label>
              <Input
                type="number"
                min={1}
                value={settings.topicAlias ?? ''}
                onChange={(e) => patch({ topicAlias: num(e.target.value) })}
                placeholder={serverTopicAliasMaximum ? 'optional' : 'not offered by broker'}
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Response topic</Label>
              <Input
                value={settings.responseTopic ?? ''}
                onChange={(e) => patch({ responseTopic: e.target.value || undefined })}
                placeholder="auto for Request"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Correlation data</Label>
              <Input
                value={settings.correlationData ?? ''}
                onChange={(e) => patch({ correlationData: e.target.value || undefined })}
                placeholder="auto for Request"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Request timeout (ms)</Label>
              <Input
                type="number"
                min={100}
                value={settings.requestTimeoutMs}
                onChange={(e) => patch({ requestTimeoutMs: num(e.target.value) ?? 10_000 })}
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={settings.payloadFormatIndicator === true}
              onCheckedChange={(checked) => patch({ payloadFormatIndicator: checked || undefined })}
              aria-label="Payload format indicator"
            />
            <Label className="text-xs">Payload format indicator (UTF-8 text)</Label>
          </div>
        </div>
      )}
    </div>
  );
}
