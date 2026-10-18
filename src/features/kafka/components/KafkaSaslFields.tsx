import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { KafkaConnectionFormController } from '../hooks/useKafkaConnection';
import type { KafkaHandleSecretField } from '../lib/kafkaSaslSecrets';
import type {
  KafkaConnection,
  KafkaSasl,
  KafkaSaslMechanism,
  KafkaSecretHandle,
} from '../store/useKafkaStore';
import {
  defaultKafkaSasl,
  isKafkaPasswordSasl,
  isKafkaStaticOAuthSasl,
  KAFKA_SECRET_SENTINEL,
} from '../store/useKafkaStore';

const SASL_MECHANISMS: Array<{ value: KafkaSaslMechanism; label: string }> = [
  { value: 'PLAIN', label: 'PLAIN' },
  { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' },
  { value: 'SCRAM-SHA-512', label: 'SCRAM-SHA-512' },
  { value: 'OAUTHBEARER', label: 'OAUTHBEARER' },
  { value: 'GSSAPI', label: 'GSSAPI (Kerberos)' },
  { value: 'AWS_MSK_IAM', label: 'AWS MSK IAM' },
];

const fieldClass = 'h-8 text-xs font-mono';

type SaslFieldsController = Pick<
  KafkaConnectionFormController,
  'updateAuth' | 'saslPasswordDraft' | 'setSaslPasswordDraft' | 'secretDrafts' | 'setSecretDraft'
>;

interface KafkaSaslFieldsProps {
  connection: KafkaConnection;
  sasl: KafkaSasl;
  controller: SaslFieldsController;
}

/** Mechanism picker + per-mechanism SASL fields for the Kafka connection form. */
export function KafkaSaslFields({ connection, sasl, controller }: KafkaSaslFieldsProps) {
  const { updateAuth, saslPasswordDraft, setSaslPasswordDraft, secretDrafts, setSecretDraft } =
    controller;
  const setSasl = (next: KafkaSasl): void =>
    updateAuth(connection.id, { ...connection.auth, sasl: next });

  const handleSecretInput = (
    field: KafkaHandleSecretField,
    stored: KafkaSecretHandle | undefined,
    placeholder: string
  ) => (
    <Input
      type="password"
      aria-label={placeholder}
      value={secretDrafts[field] ?? ''}
      onChange={(event) => setSecretDraft(field, event.target.value)}
      placeholder={stored ? `${placeholder} (stored securely — leave blank to keep)` : placeholder}
      className={fieldClass}
    />
  );

  return (
    <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
      <Label className="text-xs sp-label">SASL</Label>
      <Select
        value={sasl.mechanism}
        onValueChange={(value) => setSasl(defaultKafkaSasl(value as KafkaSaslMechanism))}
      >
        <SelectTrigger className="h-8 text-xs" aria-label="SASL mechanism">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SASL_MECHANISMS.map((mechanism) => (
            <SelectItem key={mechanism.value} value={mechanism.value}>
              {mechanism.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isKafkaPasswordSasl(sasl) && (
        <>
          <Input
            value={sasl.username}
            onChange={(event) => setSasl({ ...sasl, username: event.target.value })}
            placeholder="Username"
            className={fieldClass}
          />
          <Input
            type="password"
            value={saslPasswordDraft}
            onChange={(event) => setSaslPasswordDraft(event.target.value)}
            placeholder={
              sasl.password === KAFKA_SECRET_SENTINEL
                ? 'Password (stored — leave blank to keep)'
                : 'Password'
            }
            className={fieldClass}
          />
        </>
      )}

      {sasl.mechanism === 'OAUTHBEARER' && (
        <Select
          value={sasl.mode ?? 'static'}
          onValueChange={(mode) =>
            setSasl(
              mode === 'client-credentials'
                ? {
                    mechanism: 'OAUTHBEARER',
                    mode: 'client-credentials',
                    tokenEndpoint: '',
                    clientId: '',
                  }
                : defaultKafkaSasl('OAUTHBEARER')
            )
          }
        >
          <SelectTrigger className="h-8 text-xs" aria-label="OAuth token source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="static">Static token</SelectItem>
            <SelectItem value="client-credentials">Client credentials (auto-refresh)</SelectItem>
          </SelectContent>
        </Select>
      )}

      {isKafkaStaticOAuthSasl(sasl) && (
        <Input
          type="password"
          value={saslPasswordDraft}
          onChange={(event) => setSaslPasswordDraft(event.target.value)}
          placeholder={
            sasl.token === KAFKA_SECRET_SENTINEL
              ? 'Token (stored — leave blank to keep)'
              : 'Bearer token'
          }
          className={fieldClass}
        />
      )}

      {sasl.mechanism === 'OAUTHBEARER' && sasl.mode === 'client-credentials' && (
        <>
          <Input
            value={sasl.tokenEndpoint}
            onChange={(event) => setSasl({ ...sasl, tokenEndpoint: event.target.value })}
            placeholder="Token endpoint (https://idp.example.com/oauth2/token)"
            className={fieldClass}
          />
          <Input
            value={sasl.clientId}
            onChange={(event) => setSasl({ ...sasl, clientId: event.target.value })}
            placeholder="Client ID"
            className={fieldClass}
          />
          {handleSecretInput('oauthClientSecret', sasl.clientSecret, 'Client secret')}
          <Input
            value={sasl.scope ?? ''}
            onChange={(event) => setSasl({ ...sasl, scope: event.target.value })}
            placeholder="Scope (optional)"
            className={fieldClass}
          />
          <p className="text-sp-11 text-sp-muted">
            The token is fetched by the desktop app and refreshed before it expires.
          </p>
        </>
      )}

      {sasl.mechanism === 'GSSAPI' && (
        <>
          <Input
            value={sasl.serviceName ?? ''}
            onChange={(event) => setSasl({ ...sasl, serviceName: event.target.value })}
            placeholder="Kerberos service name (default: kafka)"
            className={fieldClass}
          />
          <Input
            value={sasl.principal ?? ''}
            onChange={(event) => setSasl({ ...sasl, principal: event.target.value })}
            placeholder="Client principal (optional, e.g. alice@EXAMPLE.COM)"
            className={fieldClass}
          />
          <p className="text-sp-11 text-sp-muted">
            Uses your existing Kerberos ticket (kinit). Requires the native kerberos module, which
            this build of Restura does not bundle.
          </p>
        </>
      )}

      {sasl.mechanism === 'AWS_MSK_IAM' && (
        <>
          <Input
            value={sasl.region}
            onChange={(event) => setSasl({ ...sasl, region: event.target.value })}
            placeholder="AWS region (e.g. us-east-1)"
            className={fieldClass}
          />
          <Select
            value={sasl.credentialSource}
            onValueChange={(value) =>
              setSasl({ ...sasl, credentialSource: value as 'static' | 'profile' })
            }
          >
            <SelectTrigger className="h-8 text-xs" aria-label="AWS credentials source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="static">Access keys</SelectItem>
              <SelectItem value="profile">AWS profile</SelectItem>
            </SelectContent>
          </Select>
          {sasl.credentialSource === 'profile' ? (
            <Input
              value={sasl.profile ?? ''}
              onChange={(event) => setSasl({ ...sasl, profile: event.target.value })}
              placeholder="Profile name (from ~/.aws/config)"
              className={fieldClass}
            />
          ) : (
            <>
              <Input
                value={sasl.accessKeyId ?? ''}
                onChange={(event) => setSasl({ ...sasl, accessKeyId: event.target.value })}
                placeholder="Access key ID"
                className={fieldClass}
              />
              {handleSecretInput('awsSecretAccessKey', sasl.secretAccessKey, 'Secret access key')}
              {handleSecretInput('awsSessionToken', sasl.sessionToken, 'Session token (optional)')}
            </>
          )}
          <p className="text-sp-11 text-sp-muted">Requires SASL_SSL (the MSK IAM listener).</p>
        </>
      )}
    </div>
  );
}
