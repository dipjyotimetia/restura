/**
 * Kafka connection ⇄ collection preset (#984).
 *
 * `kafkaPresetFromConnection` snapshots a live panel connection (plus its
 * produce draft) into a secret-free `KafkaRequest`; `applyKafkaPreset` seeds a
 * fresh tab connection from one. Credentials never enter the preset: they are
 * copied between secure-storage scopes instead — the live connection's scope
 * (`kafka:<connectionId>:<field>`) and the preset's own scope
 * (`kafka:preset-<requestId>:<field>`), both in the desktop encrypted store.
 */

import { v4 as uuidv4 } from 'uuid';
import { type KafkaSecretField, kafkaSecretKey } from '@/features/kafka/lib/kafkaManager';
import {
  isKafkaPasswordSasl,
  isKafkaStaticOAuthSasl,
  KAFKA_SECRET_SENTINEL,
  type KafkaAuth,
  type KafkaConnection,
  useKafkaStore,
} from '@/features/kafka/store/useKafkaStore';
import { secureStorage } from '@/lib/shared/secure-storage';
import {
  getKafkaProduceDraft,
  getPendingSecret,
  type KafkaProduceDraft,
  setKafkaProduceDraft,
} from '@/lib/shared/streaming/composerDrafts';
import type { KafkaPresetConnection, KafkaRequest } from '@/types';

const SECRET_FIELDS: readonly KafkaSecretField[] = [
  'sasl-password',
  'oauth-token',
  'tls-passphrase',
  'registry-password',
  'registry-token',
];

/** Secure-storage scope that holds a saved preset's credentials. */
export function kafkaPresetSecretScope(requestId: string): string {
  return `preset-${requestId}`;
}

const EMPTY_DRAFT: KafkaProduceDraft = {
  key: '',
  keyEncoding: 'utf8',
  value: '',
  valueEncoding: 'utf8',
  headers: [],
  partition: '',
};

function presetConnection(conn: KafkaConnection): KafkaPresetConnection {
  const { auth } = conn;
  const out: KafkaPresetConnection = {
    bootstrapBrokers: [...conn.bootstrapBrokers],
    clientId: conn.clientId,
    securityProtocol: auth.securityProtocol,
    acks: conn.acks,
    compression: conn.compression,
    idempotent: conn.idempotent,
  };
  // Only password and static-token SASL fit a preset. OAuth client-credentials,
  // AWS MSK IAM and GSSAPI are SecretRef/profile-backed and are re-entered on open.
  // Likewise a Schema Registry bearer token held as a keychain handle / external
  // ref is not copied (only inline strings are); the registry authType is kept so
  // Connect reports "Missing Schema Registry bearer token" rather than a 401.
  if (isKafkaStaticOAuthSasl(auth.sasl)) {
    out.sasl = {
      mechanism: 'OAUTHBEARER',
      ...(auth.sasl.extensions ? { extensions: { ...auth.sasl.extensions } } : {}),
    };
  } else if (isKafkaPasswordSasl(auth.sasl)) {
    out.sasl = { mechanism: auth.sasl.mechanism, username: auth.sasl.username };
  }
  if (auth.tls) {
    const { caPath, certPath, keyPath, rejectUnauthorized } = auth.tls;
    out.tls = {
      ...(caPath !== undefined ? { caPath } : {}),
      ...(certPath !== undefined ? { certPath } : {}),
      ...(keyPath !== undefined ? { keyPath } : {}),
      ...(rejectUnauthorized !== undefined ? { rejectUnauthorized } : {}),
    };
  }
  if (conn.registry) {
    out.registry = {
      url: conn.registry.url,
      ...(conn.registry.authType ? { authType: conn.registry.authType } : {}),
      ...(conn.registry.auth?.username !== undefined
        ? { username: conn.registry.auth.username }
        : {}),
    };
  }
  if (conn.transactionalId) out.transactionalId = conn.transactionalId;
  return out;
}

/** Snapshot a live connection + its produce draft into a secret-free preset. */
export function kafkaPresetFromConnection(
  conn: KafkaConnection,
  name: string,
  id: string = uuidv4()
): KafkaRequest {
  const draft = getKafkaProduceDraft(conn.id) ?? EMPTY_DRAFT;
  const partition = draft.partition.trim() ? Number(draft.partition) : undefined;
  return {
    id,
    name,
    type: 'kafka',
    connection: presetConnection(conn),
    produce: {
      topic: conn.defaultTopic,
      key: draft.key,
      keyEncoding: draft.keyEncoding,
      value: draft.value,
      valueEncoding: draft.valueEncoding,
      headers: draft.headers.map((h) => ({ ...h })),
      ...(partition !== undefined && Number.isSafeInteger(partition) && partition >= 0
        ? { partition }
        : {}),
    },
    consume: {
      groupId: conn.consumer.groupId,
      topics: [...conn.consumer.topics],
      // 'last-n' is a browse-only start; presets carry the closest group-safe mode.
      mode: conn.consumer.mode === 'last-n' ? 'latest' : conn.consumer.mode,
    },
  };
}

function presetAuth(c: KafkaPresetConnection): KafkaAuth {
  const auth: KafkaAuth = { securityProtocol: c.securityProtocol };
  if (c.sasl) {
    auth.sasl =
      c.sasl.mechanism === 'OAUTHBEARER'
        ? {
            mechanism: 'OAUTHBEARER',
            token: '',
            ...(c.sasl.extensions ? { extensions: { ...c.sasl.extensions } } : {}),
          }
        : { mechanism: c.sasl.mechanism, username: c.sasl.username ?? '', password: '' };
  }
  if (c.tls) auth.tls = { ...c.tls };
  return auth;
}

/** Seed connection `connectionId` (a fresh tab connection) from a preset. */
export function applyKafkaPreset(connectionId: string, preset: KafkaRequest): void {
  const store = useKafkaStore.getState();
  const c = preset.connection;
  store.updateConnection(connectionId, {
    name: preset.name,
    clientId: c.clientId || `restura-${connectionId.slice(0, 8)}`,
    bootstrapBrokers: [...c.bootstrapBrokers],
    defaultTopic: preset.produce.topic,
    acks: c.acks,
    compression: c.compression,
    idempotent: c.idempotent,
    transactionalId: c.transactionalId,
    registry: c.registry
      ? {
          url: c.registry.url,
          ...(c.registry.authType ? { authType: c.registry.authType } : {}),
          ...(c.registry.username !== undefined ? { auth: { username: c.registry.username } } : {}),
        }
      : undefined,
  });
  store.updateAuth(connectionId, presetAuth(c));
  store.updateConsumer(connectionId, {
    ...(preset.consume.groupId ? { groupId: preset.consume.groupId } : {}),
    topics: [...preset.consume.topics],
    mode: preset.consume.mode,
    fromBeginning: preset.consume.mode === 'earliest',
  });
  setKafkaProduceDraft(connectionId, {
    key: preset.produce.key,
    keyEncoding: preset.produce.keyEncoding,
    value: preset.produce.value,
    valueEncoding: preset.produce.valueEncoding,
    headers: preset.produce.headers.map((h) => ({ ...h })),
    partition: preset.produce.partition !== undefined ? String(preset.produce.partition) : '',
  });
}

export type KafkaPresetSecrets = Partial<Record<KafkaSecretField, string>>;

/**
 * The value a connection holds for one credential field: the stored secret
 * when the field carries the sentinel, a credential typed but not yet
 * connected (pending draft), or plaintext sitting on the field itself.
 */
async function heldSecret(
  connectionId: string,
  field: KafkaSecretField,
  value: string | undefined
): Promise<string | null> {
  const key = kafkaSecretKey(connectionId, field);
  const pending = getPendingSecret(key);
  if (pending) return pending;
  if (value === KAFKA_SECRET_SENTINEL) return secureStorage.getAsync(key);
  return value ? value : null;
}

/**
 * Save side: copy the credentials a live connection holds into the preset's
 * scope — stored (sentinel) values, credentials typed before connecting, and
 * plaintext on the field. Fields the connection does not hold are cleared from
 * the preset scope so a re-save never keeps a stale secret.
 */
export async function storeKafkaPresetSecrets(
  conn: KafkaConnection,
  requestId: string
): Promise<void> {
  const target = kafkaPresetSecretScope(requestId);
  const sasl = conn.auth.sasl;
  const fieldValue: Record<KafkaSecretField, string | undefined> = {
    'sasl-password': isKafkaPasswordSasl(sasl) ? sasl.password : undefined,
    'oauth-token': isKafkaStaticOAuthSasl(sasl) ? sasl.token : undefined,
    'tls-passphrase': conn.auth.tls?.passphrase,
    'registry-password': conn.registry?.auth?.password,
    // Handles / external refs are references, not plaintext — only strings are stored.
    'registry-token':
      typeof conn.registry?.bearerToken === 'string' ? conn.registry.bearerToken : undefined,
  };
  for (const field of SECRET_FIELDS) {
    const value = await heldSecret(conn.id, field, fieldValue[field]);
    if (value) secureStorage.set(kafkaSecretKey(target, field), value);
    else secureStorage.remove(kafkaSecretKey(target, field));
  }
}

/** Read the credentials stored for a preset (absent fields omitted). */
export async function readKafkaPresetSecrets(requestId: string): Promise<KafkaPresetSecrets> {
  const scope = kafkaPresetSecretScope(requestId);
  const out: KafkaPresetSecrets = {};
  for (const field of SECRET_FIELDS) {
    const value = await secureStorage.getAsync(kafkaSecretKey(scope, field));
    if (value) out[field] = value;
  }
  return out;
}

/**
 * Write preset credentials onto a tab connection (synchronously) and mark the
 * matching fields with the sentinel so the manager resolves them at connect.
 */
export function applyKafkaPresetSecrets(connectionId: string, secrets: KafkaPresetSecrets): void {
  const fields = SECRET_FIELDS.filter((field) => secrets[field]);
  if (fields.length === 0) return;
  for (const field of fields) {
    secureStorage.set(kafkaSecretKey(connectionId, field), secrets[field] as string);
  }
  const store = useKafkaStore.getState();
  const conn = store.connections[connectionId];
  if (!conn) return;
  const auth: KafkaAuth = { ...conn.auth };
  if (isKafkaStaticOAuthSasl(auth.sasl) && secrets['oauth-token']) {
    auth.sasl = { ...auth.sasl, token: KAFKA_SECRET_SENTINEL };
  } else if (isKafkaPasswordSasl(auth.sasl) && secrets['sasl-password']) {
    auth.sasl = { ...auth.sasl, password: KAFKA_SECRET_SENTINEL };
  }
  if (auth.tls && secrets['tls-passphrase']) {
    auth.tls = { ...auth.tls, passphrase: KAFKA_SECRET_SENTINEL };
  }
  store.updateAuth(connectionId, auth);
  if (conn.registry && secrets['registry-token']) {
    store.updateConnection(connectionId, {
      registry: { ...conn.registry, bearerToken: KAFKA_SECRET_SENTINEL },
    });
  } else if (conn.registry && secrets['registry-password']) {
    store.updateConnection(connectionId, {
      registry: {
        ...conn.registry,
        auth: { ...(conn.registry.auth ?? {}), password: KAFKA_SECRET_SENTINEL },
      },
    });
  }
}

/** Open side: copy a preset's stored credentials onto the tab connection. */
export async function restoreKafkaPresetSecrets(
  requestId: string,
  connectionId: string
): Promise<void> {
  applyKafkaPresetSecrets(connectionId, await readKafkaPresetSecrets(requestId));
}

/** Delete every credential stored for a preset (preset deleted). */
export function reapKafkaPresetSecrets(requestId: string): void {
  const scope = kafkaPresetSecretScope(requestId);
  for (const field of SECRET_FIELDS) secureStorage.remove(kafkaSecretKey(scope, field));
}

/** Copy a preset's credentials to another preset id (duplicate). */
export async function copyKafkaPresetSecrets(fromId: string, toId: string): Promise<void> {
  const secrets = await readKafkaPresetSecrets(fromId);
  const scope = kafkaPresetSecretScope(toId);
  for (const field of SECRET_FIELDS) {
    const value = secrets[field];
    if (value) secureStorage.set(kafkaSecretKey(scope, field), value);
  }
}
