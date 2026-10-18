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
import type { KafkaConnectionFormController } from '../hooks/useKafkaConnection';
import { type KafkaHandleSecretField, kafkaSaslPreflightError } from '../lib/kafkaSaslSecrets';
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

const SASL_MECHANISMS: Array<{ value: KafkaSaslMechanism; label: string; disabled?: boolean }> = [
  { value: 'PLAIN', label: 'PLAIN' },
  { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' },
  { value: 'SCRAM-SHA-512', label: 'SCRAM-SHA-512' },
  { value: 'OAUTHBEARER', label: 'OAUTHBEARER' },
  { value: 'AWS_MSK_IAM', label: 'AWS MSK IAM' },
  // The authenticator exists in main, but the native `kerberos` module it needs
  // is not bundled with the desktop build, so the option is not selectable.
  { value: 'GSSAPI', label: 'GSSAPI (Kerberos) — not available in this build', disabled: true },
];

const fieldClass = 'h-8 text-xs font-mono';

type SaslFieldsController = Pick<
  KafkaConnectionFormController,
  | 'updateAuth'
  | 'replaceSasl'
  | 'saslPasswordDraft'
  | 'setSaslPasswordDraft'
  | 'secretDrafts'
  | 'setSecretDraft'
>;

interface KafkaSaslFieldsProps {
  connection: KafkaConnection;
  sasl: KafkaSasl;
  controller: SaslFieldsController;
}

/** Mechanism picker + per-mechanism SASL fields for the Kafka connection form. */
export function KafkaSaslFields({ connection, sasl, controller }: KafkaSaslFieldsProps) {
  const {
    updateAuth,
    replaceSasl,
    saslPasswordDraft,
    setSaslPasswordDraft,
    secretDrafts,
    setSecretDraft,
  } = controller;
  /** Field edits within the same mechanism keep drafts and handles. */
  const setSasl = (next: KafkaSasl): void =>
    updateAuth(connection.id, { ...connection.auth, sasl: next });
  const preflight = kafkaSaslPreflightError(
    sasl,
    connection.auth.securityProtocol,
    connection.bootstrapBrokers
  );

  const textInput = (label: string, value: string, onChange: (next: string) => void) => (
    <Input
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={label}
      className={fieldClass}
    />
  );

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
        onValueChange={(value) => replaceSasl(defaultKafkaSasl(value as KafkaSaslMechanism))}
      >
        <SelectTrigger className="h-8 text-xs" aria-label="SASL mechanism">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SASL_MECHANISMS.map((mechanism) => (
            <SelectItem
              key={mechanism.value}
              value={mechanism.value}
              {...(mechanism.disabled ? { disabled: true } : {})}
            >
              {mechanism.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isKafkaPasswordSasl(sasl) && (
        <>
          {textInput('Username', sasl.username, (username) => setSasl({ ...sasl, username }))}
          <Input
            type="password"
            aria-label="Password"
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
            replaceSasl(
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
          aria-label="Bearer token"
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
          {textInput(
            'Token endpoint (https://idp.example.com/oauth2/token)',
            sasl.tokenEndpoint,
            (tokenEndpoint) => setSasl({ ...sasl, tokenEndpoint })
          )}
          {textInput('Client ID', sasl.clientId, (clientId) => setSasl({ ...sasl, clientId }))}
          {handleSecretInput('oauthClientSecret', sasl.clientSecret, 'Client secret')}
          {textInput('Scope (optional)', sasl.scope ?? '', (scope) => setSasl({ ...sasl, scope }))}
          <p className="text-sp-11 text-sp-muted">
            The token is fetched by the desktop app over https and refreshed before it expires.
          </p>
        </>
      )}

      {sasl.mechanism === 'GSSAPI' && (
        <>
          {textInput(
            'Kerberos service name (default: kafka)',
            sasl.serviceName ?? '',
            (serviceName) => setSasl({ ...sasl, serviceName })
          )}
          {textInput(
            'Client principal (optional, e.g. alice@EXAMPLE.COM)',
            sasl.principal ?? '',
            (principal) => setSasl({ ...sasl, principal })
          )}
          <p className="text-sp-11 text-sp-muted">
            GSSAPI needs the native kerberos module, which this build of Restura does not bundle, so
            connections will fail.
          </p>
        </>
      )}

      {sasl.mechanism === 'AWS_MSK_IAM' && (
        <>
          {textInput('AWS region (e.g. us-east-1)', sasl.region, (region) =>
            setSasl({ ...sasl, region })
          )}
          <Select
            value={sasl.credentialSource}
            onValueChange={(value) =>
              // Switching source drops the other source's key id, profile and
              // stored secret handles.
              replaceSasl({
                mechanism: 'AWS_MSK_IAM',
                region: sasl.region,
                credentialSource: value as 'static' | 'profile',
                ...(sasl.allowNonAwsBrokerHosts ? { allowNonAwsBrokerHosts: true } : {}),
              })
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
            textInput('Profile name (from ~/.aws/config)', sasl.profile ?? '', (profile) =>
              setSasl({ ...sasl, profile })
            )
          ) : (
            <>
              {textInput('Access key ID', sasl.accessKeyId ?? '', (accessKeyId) =>
                setSasl({ ...sasl, accessKeyId })
              )}
              {handleSecretInput('awsSecretAccessKey', sasl.secretAccessKey, 'Secret access key')}
              {handleSecretInput('awsSessionToken', sasl.sessionToken, 'Session token (optional)')}
            </>
          )}
          <div className="flex items-center gap-2">
            <Switch
              id={`kafka-msk-non-aws-${connection.id}`}
              checked={sasl.allowNonAwsBrokerHosts === true}
              onCheckedChange={(checked) =>
                setSasl({ ...sasl, allowNonAwsBrokerHosts: checked ? true : undefined })
              }
            />
            <Label htmlFor={`kafka-msk-non-aws-${connection.id}`} className="text-xs">
              Allow non-AWS broker hostnames (PrivateLink / custom DNS)
            </Label>
          </div>
          {sasl.allowNonAwsBrokerHosts === true && (
            <p className="text-sp-11 text-warning" role="note">
              The signed AWS token for these credentials will be sent to every bootstrap broker.
              Only enable this for brokers you control.
            </p>
          )}
          <p className="text-sp-11 text-sp-muted">Requires SASL_SSL (the MSK IAM listener).</p>
        </>
      )}

      {preflight && (
        <p className="text-sp-11 text-destructive" role="alert">
          {preflight}
        </p>
      )}
    </div>
  );
}
