import type { KafkaSasl, KafkaSecretHandle } from '@/features/kafka/store/useKafkaStore';

/**
 * SASL secrets that are stored as SecretRef handles (ADR-0007) rather than the
 * legacy secureStorage sentinel: the OAuth client-credentials client secret and
 * the AWS MSK IAM secret key / session token. The renderer only ever keeps the
 * opaque handle; main resolves the plaintext when it fetches or signs a token.
 */
export type KafkaHandleSecretField = 'oauthClientSecret' | 'awsSecretAccessKey' | 'awsSessionToken';

export type KafkaHandleSecretDrafts = Partial<Record<KafkaHandleSecretField, string>>;

export type StoreSecretFn = (args: {
  value: string;
  label: string;
  scope: string;
  id?: string;
}) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;

const FIELD_LABELS: Record<KafkaHandleSecretField, string> = {
  oauthClientSecret: 'OAuth client secret',
  awsSecretAccessKey: 'AWS secret access key',
  awsSessionToken: 'AWS session token',
};

async function storeHandle(
  storeSecret: StoreSecretFn,
  value: string,
  label: string,
  existing: KafkaSecretHandle | undefined
): Promise<KafkaSecretHandle> {
  // Re-use the existing handle id so re-entering a secret updates it in place
  // instead of orphaning the previous keychain entry.
  const result = await storeSecret({
    value,
    label,
    scope: 'kafka',
    ...(existing ? { id: existing.id } : {}),
  });
  if (!result.ok) throw new Error(`Failed to store ${label}: ${result.error}`);
  return { kind: 'handle', id: result.id, label };
}

/**
 * Move any typed secret drafts into the handle store and return the SASL block
 * that references them. Returns the input unchanged when there is nothing to
 * store. Throws when secure storage is unavailable or rejects the value.
 */
export async function persistKafkaSaslSecrets(
  sasl: KafkaSasl,
  drafts: KafkaHandleSecretDrafts,
  connectionName: string,
  storeSecret: StoreSecretFn | undefined
): Promise<KafkaSasl> {
  const wanted = (field: KafkaHandleSecretField): string | undefined => drafts[field] || undefined;
  const label = (field: KafkaHandleSecretField) =>
    `Kafka ${connectionName} / ${FIELD_LABELS[field]}`;
  const requireStore = (): StoreSecretFn => {
    if (!storeSecret) throw new Error('Secure secret storage is unavailable.');
    return storeSecret;
  };

  if (sasl.mechanism === 'OAUTHBEARER' && sasl.mode === 'client-credentials') {
    const value = wanted('oauthClientSecret');
    if (!value) return sasl;
    return {
      ...sasl,
      clientSecret: await storeHandle(
        requireStore(),
        value,
        label('oauthClientSecret'),
        sasl.clientSecret
      ),
    };
  }

  if (sasl.mechanism === 'AWS_MSK_IAM') {
    const secret = wanted('awsSecretAccessKey');
    const session = wanted('awsSessionToken');
    if (!secret && !session) return sasl;
    const next = { ...sasl };
    if (secret) {
      next.secretAccessKey = await storeHandle(
        requireStore(),
        secret,
        label('awsSecretAccessKey'),
        sasl.secretAccessKey
      );
    }
    if (session) {
      next.sessionToken = await storeHandle(
        requireStore(),
        session,
        label('awsSessionToken'),
        sasl.sessionToken
      );
    }
    return next;
  }

  return sasl;
}
