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
  KAFKA_SECRET_SENTINEL,
  type KafkaAuth,
  type KafkaConnection,
  useKafkaStore,
} from '@/features/kafka/store/useKafkaStore';
import { secureStorage } from '@/lib/shared/secure-storage';
import {
  getKafkaProduceDraft,
  type KafkaProduceDraft,
  setKafkaProduceDraft,
} from '@/lib/shared/streaming/composerDrafts';
import type { KafkaPresetConnection, KafkaRequest } from '@/types';

const SECRET_FIELDS: readonly KafkaSecretField[] = [
  'sasl-password',
  'oauth-token',
  'tls-passphrase',
  'registry-password',
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
  if (auth.sasl) {
    out.sasl =
      auth.sasl.mechanism === 'OAUTHBEARER'
        ? {
            mechanism: 'OAUTHBEARER',
            ...(auth.sasl.extensions ? { extensions: { ...auth.sasl.extensions } } : {}),
          }
        : { mechanism: auth.sasl.mechanism, username: auth.sasl.username };
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
      mode: conn.consumer.mode,
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

/** Copy every stored secret field from one scope to another; returns the copied fields. */
async function copySecrets(fromScope: string, toScope: string): Promise<Set<KafkaSecretField>> {
  const copied = new Set<KafkaSecretField>();
  for (const field of SECRET_FIELDS) {
    const value = await secureStorage.getAsync(kafkaSecretKey(fromScope, field));
    if (value) {
      secureStorage.set(kafkaSecretKey(toScope, field), value);
      copied.add(field);
    } else {
      secureStorage.remove(kafkaSecretKey(toScope, field));
    }
  }
  return copied;
}

/**
 * Save side: copy the credentials a live connection has stored (sentinel
 * fields only) into the preset's scope. Fields the connection does not hold
 * are cleared from the preset scope so a re-save never keeps a stale secret.
 */
export async function storeKafkaPresetSecrets(
  conn: KafkaConnection,
  requestId: string
): Promise<void> {
  const target = kafkaPresetSecretScope(requestId);
  const sasl = conn.auth.sasl;
  const held: Record<KafkaSecretField, boolean> = {
    'sasl-password': sasl?.mechanism !== 'OAUTHBEARER' && sasl?.password === KAFKA_SECRET_SENTINEL,
    'oauth-token': sasl?.mechanism === 'OAUTHBEARER' && sasl.token === KAFKA_SECRET_SENTINEL,
    'tls-passphrase': conn.auth.tls?.passphrase === KAFKA_SECRET_SENTINEL,
    'registry-password': conn.registry?.auth?.password === KAFKA_SECRET_SENTINEL,
  };
  for (const field of SECRET_FIELDS) {
    const value = held[field] ? await secureStorage.getAsync(kafkaSecretKey(conn.id, field)) : null;
    if (value) secureStorage.set(kafkaSecretKey(target, field), value);
    else secureStorage.remove(kafkaSecretKey(target, field));
  }
}

/**
 * Open side: copy a preset's stored credentials onto the tab connection and
 * mark the matching fields with the sentinel so the manager resolves them.
 */
export async function restoreKafkaPresetSecrets(
  requestId: string,
  connectionId: string
): Promise<void> {
  const copied = await copySecrets(kafkaPresetSecretScope(requestId), connectionId);
  if (copied.size === 0) return;
  const store = useKafkaStore.getState();
  const conn = store.connections[connectionId];
  if (!conn) return;
  const auth: KafkaAuth = { ...conn.auth };
  if (auth.sasl?.mechanism === 'OAUTHBEARER' && copied.has('oauth-token')) {
    auth.sasl = { ...auth.sasl, token: KAFKA_SECRET_SENTINEL };
  } else if (auth.sasl && auth.sasl.mechanism !== 'OAUTHBEARER' && copied.has('sasl-password')) {
    auth.sasl = { ...auth.sasl, password: KAFKA_SECRET_SENTINEL };
  }
  if (auth.tls && copied.has('tls-passphrase')) {
    auth.tls = { ...auth.tls, passphrase: KAFKA_SECRET_SENTINEL };
  }
  store.updateAuth(connectionId, auth);
  if (conn.registry && copied.has('registry-password')) {
    store.updateConnection(connectionId, {
      registry: {
        ...conn.registry,
        auth: { ...(conn.registry.auth ?? {}), password: KAFKA_SECRET_SENTINEL },
      },
    });
  }
}
