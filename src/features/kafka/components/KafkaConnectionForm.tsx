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
import type { KafkaConnectionFormController } from '../hooks/useKafkaConnection';
import type {
  KafkaConnection,
  KafkaSaslMechanism,
  KafkaSecurityProtocol,
} from '../store/useKafkaStore';
import { KAFKA_SECRET_SENTINEL } from '../store/useKafkaStore';

const SECURITY_PROTOCOLS: KafkaSecurityProtocol[] = [
  'PLAINTEXT',
  'SASL_PLAINTEXT',
  'SASL_SSL',
  'SSL',
];
const SASL_MECHANISMS: KafkaSaslMechanism[] = ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512'];

interface KafkaConnectionFormProps {
  connection: KafkaConnection;
  controller: KafkaConnectionFormController;
}

/** Desktop-only connection settings, separated from the Kafka message client. */
export function KafkaConnectionForm({ connection, controller }: KafkaConnectionFormProps) {
  const {
    updateConnection,
    updateAuth,
    brokerDraft,
    setBrokerDraft,
    saslPasswordDraft,
    setSaslPasswordDraft,
    tlsPassphraseDraft,
    setTlsPassphraseDraft,
    registryPasswordDraft,
    setRegistryPasswordDraft,
    patchRegistry,
    addBroker,
    removeBroker,
    pickTlsFile,
    setSecurityProtocol,
  } = controller;

  return (
    <TabsContent value="connection" className="flex-1 overflow-auto m-0">
      <Floater radius="panel" className="p-3 space-y-4">
        <div className="space-y-2">
          <Label className="text-xs sp-label">Connection name</Label>
          <Input
            value={connection.name}
            onChange={(event) => updateConnection(connection.id, { name: event.target.value })}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sp-label">Client ID</Label>
          <Input
            value={connection.clientId}
            onChange={(event) => updateConnection(connection.id, { clientId: event.target.value })}
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs sp-label">Bootstrap brokers</Label>
          <div className="flex flex-wrap gap-1">
            {connection.bootstrapBrokers.map((broker, index) => (
              <Badge key={`${broker}-${index}`} variant="secondary" className="gap-1 font-mono">
                {broker}
                <button onClick={() => removeBroker(index)} aria-label={`Remove broker ${broker}`}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={brokerDraft}
              onChange={(event) => setBrokerDraft(event.target.value)}
              placeholder="host:port"
              className="h-8 text-xs font-mono"
            />
            <Button size="sm" variant="secondary" onClick={addBroker}>
              Add
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs sp-label">Security protocol</Label>
          <Select
            value={connection.auth.securityProtocol}
            onValueChange={(value) => setSecurityProtocol(value as KafkaSecurityProtocol)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECURITY_PROTOCOLS.map((protocol) => (
                <SelectItem key={protocol} value={protocol}>
                  {protocol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(connection.auth.securityProtocol === 'SASL_PLAINTEXT' ||
          connection.auth.securityProtocol === 'SASL_SSL') &&
          connection.auth.sasl && (
            <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
              <Label className="text-xs sp-label">SASL</Label>
              <Select
                value={connection.auth.sasl.mechanism}
                onValueChange={(value) =>
                  updateAuth(connection.id, {
                    ...connection.auth,
                    sasl: {
                      ...connection.auth.sasl!,
                      mechanism: value as KafkaSaslMechanism,
                    },
                  })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SASL_MECHANISMS.map((mechanism) => (
                    <SelectItem key={mechanism} value={mechanism}>
                      {mechanism}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={connection.auth.sasl.username}
                onChange={(event) =>
                  updateAuth(connection.id, {
                    ...connection.auth,
                    sasl: { ...connection.auth.sasl!, username: event.target.value },
                  })
                }
                placeholder="Username"
                className="h-8 text-xs font-mono"
              />
              <Input
                type="password"
                value={saslPasswordDraft}
                onChange={(event) => setSaslPasswordDraft(event.target.value)}
                placeholder={
                  connection.auth.sasl.password === KAFKA_SECRET_SENTINEL
                    ? 'Password (stored — leave blank to keep)'
                    : 'Password'
                }
                className="h-8 text-xs font-mono"
              />
            </div>
          )}

        {(connection.auth.securityProtocol === 'SASL_SSL' ||
          connection.auth.securityProtocol === 'SSL') && (
          <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
            <Label className="text-xs sp-label">TLS</Label>
            {(['caPath', 'certPath', 'keyPath'] as const).map((field) => (
              <div key={field} className="flex gap-2">
                <Input
                  value={connection.auth.tls?.[field] ?? ''}
                  readOnly
                  placeholder={field}
                  className="h-8 text-xs font-mono"
                />
                <Button size="sm" variant="secondary" onClick={() => pickTlsFile(field)}>
                  Browse
                </Button>
              </div>
            ))}
            <Input
              type="password"
              value={tlsPassphraseDraft}
              onChange={(event) => setTlsPassphraseDraft(event.target.value)}
              placeholder={
                connection.auth.tls?.passphrase === KAFKA_SECRET_SENTINEL
                  ? 'Key passphrase (stored — leave blank to keep)'
                  : 'Key passphrase (optional)'
              }
              className="h-8 text-xs font-mono"
            />
            <div className="flex items-center gap-2">
              <Switch
                checked={connection.auth.tls?.rejectUnauthorized !== false}
                onCheckedChange={(checked) =>
                  updateAuth(connection.id, {
                    ...connection.auth,
                    tls: { ...(connection.auth.tls ?? {}), rejectUnauthorized: checked },
                  })
                }
              />
              <Label className="text-xs">Verify server certificate</Label>
            </div>
          </div>
        )}

        <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
          <div className="flex items-center justify-between">
            <Label className="text-xs sp-label">Schema Registry</Label>
            <Switch
              checked={!!connection.registry}
              onCheckedChange={(checked) =>
                updateConnection(connection.id, {
                  registry: checked ? (connection.registry ?? { url: '' }) : undefined,
                })
              }
            />
          </div>
          {connection.registry && (
            <>
              <Input
                value={connection.registry.url}
                onChange={(event) => patchRegistry({ url: event.target.value })}
                placeholder="https://schema-registry:8081"
                className="h-8 text-xs font-mono"
              />
              <Input
                value={connection.registry.auth?.username ?? ''}
                onChange={(event) =>
                  patchRegistry({
                    auth: { ...(connection.registry!.auth ?? {}), username: event.target.value },
                  })
                }
                placeholder="Username (optional)"
                className="h-8 text-xs font-mono"
              />
              <Input
                type="password"
                value={registryPasswordDraft}
                onChange={(event) => setRegistryPasswordDraft(event.target.value)}
                placeholder={
                  connection.registry.auth?.password === KAFKA_SECRET_SENTINEL
                    ? 'Password (stored — leave blank to keep)'
                    : 'Password (optional)'
                }
                className="h-8 text-xs font-mono"
              />
              <p className="text-sp-11 text-sp-muted">
                Decodes Avro / Protobuf / JSON messages on consume.
              </p>
            </>
          )}
        </div>
      </Floater>
    </TabsContent>
  );
}
