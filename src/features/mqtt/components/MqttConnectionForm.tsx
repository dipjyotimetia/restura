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
import { Textarea } from '@/components/ui/textarea';
import type {
  MqttConnection,
  MqttConnectProperties,
  MqttLwt,
  MqttProtocolVersion,
  MqttTls,
  MqttWillProperties,
} from '@/features/mqtt/store/useMqttStore';
import { MQTT_SECRET_SENTINEL } from '@/features/mqtt/store/useMqttStore';
import { QosSelect } from './mqttUi';

type ConnectionPatch = Partial<
  Omit<MqttConnection, 'id' | 'createdAt' | 'messages' | 'subscriptions'>
>;
type TlsFileField = 'caPath' | 'certPath' | 'keyPath';

/** `key=value` lines ⇄ MQTT 5 user properties. */
export function parseUserProperties(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function formatUserProperties(props: Record<string, string> | undefined): string {
  return props
    ? Object.entries(props)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : '';
}

function optionalNumber(value: string): number | undefined {
  return value.trim() === '' || Number.isNaN(Number(value)) ? undefined : Number(value);
}

function NumberField({
  label,
  value,
  onChange,
  placeholder = 'optional',
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs sp-label">{label}</Label>
      <Input
        type="number"
        min={0}
        value={value ?? ''}
        onChange={(event) => onChange(optionalNumber(event.target.value))}
        placeholder={placeholder}
        className="h-8 text-xs font-mono"
      />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder = 'optional',
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs sp-label">{label}</Label>
      <Input
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        placeholder={placeholder}
        className="h-8 text-xs font-mono"
      />
    </div>
  );
}

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
  /** Store (non-empty) or clear (empty) the enhanced-auth data as a secret handle. */
  onAuthDataCommit?: (value: string) => void;
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
  onAuthDataCommit,
}: MqttConnectionFormProps) {
  const isTls = /^(mqtts|wss):\/\//i.test(connection.brokerUrl);
  const isV5 = connection.protocolVersion === 5;
  const connectProps = connection.connectProperties ?? {};
  const patchConnectProps = (patch: Partial<MqttConnectProperties>): void =>
    onUpdateConnection({ connectProperties: { ...connectProps, ...patch } });
  const patchWillProps = (patch: Partial<MqttWillProperties>): void => {
    if (!connection.lwt) return;
    onUpdateLwt({
      ...connection.lwt,
      properties: { ...(connection.lwt.properties ?? {}), ...patch },
    });
  };

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
          <p className="text-sp-11 text-sp-dim">
            mqtt:// (TCP) · mqtts:// (TLS) · ws://host:8083/mqtt · wss://host/mqtt (MQTT over
            WebSocket)
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-xs sp-label">Client ID</Label>
            <Input
              value={connection.clientId}
              onChange={(event) => onUpdateConnection({ clientId: event.target.value })}
              placeholder={isV5 && connection.cleanStart ? 'empty = broker assigns' : undefined}
              className="h-8 text-xs font-mono"
            />
            {connection.assignedClientId && (
              <p className="text-sp-11 text-sp-dim font-mono">
                Assigned: {connection.assignedClientId}
              </p>
            )}
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

        {isV5 && (
          <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
            <Label className="text-xs sp-label">CONNECT properties (v5)</Label>
            <div className="grid grid-cols-3 gap-2">
              <NumberField
                label="Receive maximum"
                value={connectProps.receiveMaximum}
                onChange={(receiveMaximum) => patchConnectProps({ receiveMaximum })}
              />
              <NumberField
                label="Max packet size"
                value={connectProps.maximumPacketSize}
                onChange={(maximumPacketSize) => patchConnectProps({ maximumPacketSize })}
              />
              <NumberField
                label="Topic alias max"
                value={connectProps.topicAliasMaximum}
                onChange={(topicAliasMaximum) => patchConnectProps({ topicAliasMaximum })}
              />
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch
                  checked={connectProps.requestResponseInformation === true}
                  onCheckedChange={(checked) =>
                    patchConnectProps({ requestResponseInformation: checked || undefined })
                  }
                />
                <Label className="text-xs">Request response information</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={connectProps.requestProblemInformation !== false}
                  onCheckedChange={(checked) =>
                    patchConnectProps({ requestProblemInformation: checked ? undefined : false })
                  }
                />
                <Label className="text-xs">Request problem information</Label>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <TextField
                label="Auth method (enhanced auth)"
                value={connectProps.authenticationMethod}
                onChange={(authenticationMethod) => patchConnectProps({ authenticationMethod })}
                placeholder="e.g. SCRAM-SHA-1"
              />
              <div className="space-y-1">
                <Label className="text-xs sp-label">Auth data</Label>
                <Input
                  type="password"
                  defaultValue=""
                  onBlur={(event) => {
                    if (event.target.value) {
                      onAuthDataCommit?.(event.target.value);
                      event.target.value = '';
                    }
                  }}
                  placeholder={
                    connectProps.authenticationData === MQTT_SECRET_SENTINEL
                      ? 'stored — leave blank to keep'
                      : 'optional (stored securely)'
                  }
                  className="h-8 text-xs font-mono"
                />
                {connectProps.authenticationData === MQTT_SECRET_SENTINEL && (
                  <button
                    type="button"
                    className="text-sp-11 text-sp-dim hover:text-red-400"
                    onClick={() => onAuthDataCommit?.('')}
                  >
                    Clear stored auth data
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs sp-label">User properties (key=value per line)</Label>
              <Textarea
                defaultValue={formatUserProperties(connectProps.userProperties)}
                onBlur={(event) =>
                  patchConnectProps({ userProperties: parseUserProperties(event.target.value) })
                }
                className="font-mono text-xs"
                rows={2}
              />
            </div>
          </div>
        )}

        {isTls && (
          <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
            <Label className="text-xs sp-label">TLS (mqtts / wss)</Label>
            <p className="text-sp-11 text-sp-dim">
              Files are read by the desktop app at connect time — key material never enters the UI.
            </p>
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
              {isV5 && (
                <div className="space-y-2 pt-1">
                  <Label className="text-xs sp-label">Will properties (v5)</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberField
                      label="Will delay (s)"
                      value={connection.lwt.properties?.willDelayInterval}
                      onChange={(willDelayInterval) => patchWillProps({ willDelayInterval })}
                    />
                    <NumberField
                      label="Message expiry (s)"
                      value={connection.lwt.properties?.messageExpiryInterval}
                      onChange={(messageExpiryInterval) =>
                        patchWillProps({ messageExpiryInterval })
                      }
                    />
                    <TextField
                      label="Content type"
                      value={connection.lwt.properties?.contentType}
                      onChange={(contentType) => patchWillProps({ contentType })}
                    />
                    <TextField
                      label="Response topic"
                      value={connection.lwt.properties?.responseTopic}
                      onChange={(responseTopic) => patchWillProps({ responseTopic })}
                    />
                    <TextField
                      label="Correlation data"
                      value={connection.lwt.properties?.correlationData}
                      onChange={(correlationData) => patchWillProps({ correlationData })}
                    />
                    <div className="flex items-end gap-2 pb-1.5">
                      <Switch
                        checked={connection.lwt.properties?.payloadFormatIndicator === true}
                        onCheckedChange={(checked) =>
                          patchWillProps({ payloadFormatIndicator: checked || undefined })
                        }
                      />
                      <Label className="text-xs">Payload is UTF-8</Label>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs sp-label">User properties (key=value per line)</Label>
                    <Textarea
                      defaultValue={formatUserProperties(connection.lwt.properties?.userProperties)}
                      onBlur={(event) =>
                        patchWillProps({ userProperties: parseUserProperties(event.target.value) })
                      }
                      className="font-mono text-xs"
                      rows={2}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </Floater>
    </TabsContent>
  );
}
