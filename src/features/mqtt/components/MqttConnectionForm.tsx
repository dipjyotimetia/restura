import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Floater } from '@/components/ui/spatial';
import { Switch } from '@/components/ui/switch';
import { TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import type {
  MqttConnection,
  MqttLwt,
  MqttProtocolVersion,
  MqttTls,
} from '@/features/mqtt/store/useMqttStore';
import { MQTT_SECRET_SENTINEL } from '@/features/mqtt/store/useMqttStore';
import { QosSelect } from './mqttUi';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ConnectionPatch = Partial<
  Omit<MqttConnection, 'id' | 'createdAt' | 'messages' | 'subscriptions'>
>;
type TlsFileField = 'caPath' | 'certPath' | 'keyPath';

interface MqttConnectionFormProps {
  connection: MqttConnection;
  passwordDraft: string;
  passphraseDraft: string;
  onPasswordDraftChange: (value: string) => void;
  onPassphraseDraftChange: (value: string) => void;
  onPickTlsFile: (field: TlsFileField) => void;
  onUpdateConnection: (patch: ConnectionPatch) => void;
  onUpdateLwt: (lwt: MqttLwt | undefined) => void;
  onUpdateTls: (tls: MqttTls | undefined) => void;
}

/** Desktop MQTT connection settings. Secret persistence and IPC remain owned by MqttClient. */
export function MqttConnectionForm({
  connection,
  passwordDraft,
  passphraseDraft,
  onPasswordDraftChange,
  onPassphraseDraftChange,
  onPickTlsFile,
  onUpdateConnection,
  onUpdateLwt,
  onUpdateTls,
}: MqttConnectionFormProps) {
  const isTls = connection.brokerUrl.startsWith('mqtts://');

  return (
    <TabsContent value="connection" className="flex-1 overflow-auto m-0">
      <Floater radius="panel" className="p-3 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-xs sp-label">Connection name</Label>
            <Input
              value={connection.name}
              onChange={(event) => onUpdateConnection({ name: event.target.value })}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs sp-label">MQTT version</Label>
            <Select
              value={String(connection.protocolVersion)}
              onValueChange={(value) =>
                onUpdateConnection({ protocolVersion: Number(value) as MqttProtocolVersion })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5.0</SelectItem>
                <SelectItem value="4">3.1.1</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs sp-label">Broker URL</Label>
          <Input
            value={connection.brokerUrl}
            onChange={(event) => onUpdateConnection({ brokerUrl: event.target.value })}
            placeholder="mqtt://localhost:1883"
            className="h-8 text-xs font-mono"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-xs sp-label">Client ID</Label>
            <Input
              value={connection.clientId}
              onChange={(event) => onUpdateConnection({ clientId: event.target.value })}
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs sp-label">Keepalive (seconds)</Label>
            <Input
              type="number"
              value={connection.keepalive}
              onChange={(event) =>
                onUpdateConnection({ keepalive: Number(event.target.value) || 0 })
              }
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-xs sp-label">Connect timeout (ms)</Label>
            <Input
              type="number"
              value={connection.connectTimeout}
              onChange={(event) =>
                onUpdateConnection({ connectTimeout: Number(event.target.value) || 30_000 })
              }
              className="h-8 text-xs font-mono"
            />
          </div>
          {connection.protocolVersion === 5 && (
            <div className="space-y-2">
              <Label className="text-xs sp-label">Session expiry (s, v5)</Label>
              <Input
                type="number"
                value={connection.sessionExpiryInterval ?? ''}
                onChange={(event) =>
                  onUpdateConnection({
                    sessionExpiryInterval: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  })
                }
                placeholder="optional"
                className="h-8 text-xs font-mono"
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Switch
              checked={connection.cleanStart}
              onCheckedChange={(checked) => onUpdateConnection({ cleanStart: checked })}
            />
            <Label className="text-xs">
              {connection.protocolVersion === 5 ? 'Clean start' : 'Clean session'}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={connection.autoReconnect}
              onCheckedChange={(checked) => onUpdateConnection({ autoReconnect: checked })}
            />
            <Label className="text-xs">Auto-reconnect</Label>
          </div>
        </div>

        <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
          <Label className="text-xs sp-label">Credentials</Label>
          <Input
            value={connection.username ?? ''}
            onChange={(event) => onUpdateConnection({ username: event.target.value || undefined })}
            placeholder="Username (optional)"
            className="h-8 text-xs font-mono"
          />
          <Input
            type="password"
            value={passwordDraft}
            onChange={(event) => onPasswordDraftChange(event.target.value)}
            placeholder={
              connection.password === MQTT_SECRET_SENTINEL
                ? 'Password (stored — leave blank to keep)'
                : 'Password (optional)'
            }
            className="h-8 text-xs font-mono"
          />
        </div>

        {isTls && (
          <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
            <Label className="text-xs sp-label">TLS (mqtts)</Label>
            {(['caPath', 'certPath', 'keyPath'] as const).map((field) => (
              <div key={field} className="flex gap-2">
                <Input
                  value={connection.tls?.[field] ?? ''}
                  readOnly
                  placeholder={field}
                  className="h-8 text-xs font-mono"
                />
                <Button size="sm" variant="secondary" onClick={() => onPickTlsFile(field)}>
                  Browse
                </Button>
              </div>
            ))}
            <Input
              type="password"
              value={passphraseDraft}
              onChange={(event) => onPassphraseDraftChange(event.target.value)}
              placeholder={
                connection.tls?.passphrase === MQTT_SECRET_SENTINEL
                  ? 'Key passphrase (stored — leave blank to keep)'
                  : 'Key passphrase (optional)'
              }
              className="h-8 text-xs font-mono"
            />
            <div className="flex items-center gap-2">
              <Switch
                checked={connection.tls?.rejectUnauthorized !== false}
                onCheckedChange={(checked) =>
                  onUpdateTls({ ...(connection.tls ?? {}), rejectUnauthorized: checked })
                }
              />
              <Label className="text-xs">Verify server certificate</Label>
            </div>
          </div>
        )}

        <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
          <div className="flex items-center gap-2">
            <Switch
              checked={connection.lwt !== undefined}
              onCheckedChange={(checked) =>
                onUpdateLwt(checked ? { topic: '', payload: '', qos: 0, retain: false } : undefined)
              }
            />
            <Label className="text-xs sp-label">Last Will &amp; Testament</Label>
          </div>
          {connection.lwt && (
            <>
              <Input
                value={connection.lwt.topic}
                onChange={(event) => onUpdateLwt({ ...connection.lwt!, topic: event.target.value })}
                placeholder="Will topic"
                className="h-8 text-xs font-mono"
              />
              <Textarea
                value={connection.lwt.payload}
                onChange={(event) =>
                  onUpdateLwt({ ...connection.lwt!, payload: event.target.value })
                }
                placeholder="Will payload"
                className="font-mono text-xs"
                rows={2}
              />
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-xs">QoS</Label>
                  <QosSelect
                    value={connection.lwt.qos}
                    onChange={(qos) => onUpdateLwt({ ...connection.lwt!, qos })}
                    triggerClassName="h-7 w-16 text-xs"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={connection.lwt.retain}
                    onCheckedChange={(checked) =>
                      onUpdateLwt({ ...connection.lwt!, retain: checked })
                    }
                  />
                  <Label className="text-xs">Retain</Label>
                </div>
              </div>
            </>
          )}
        </div>
      </Floater>
    </TabsContent>
  );
}
