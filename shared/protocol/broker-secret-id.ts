import { v5 as uuidv5 } from 'uuid';

/**
 * Deterministic handle ids for broker (Kafka / MQTT) credentials (SEC-K3).
 *
 * The renderer stores each broker secret in the main-process secret-handle
 * store under `uuidv5(storageKey)` (`src/lib/shared/broker-secrets.ts`) and
 * sends `{ kind: 'handle', id }` on the connect IPC. Main recomputes the id
 * from the connection id + field so it only resolves the handle that belongs
 * to THAT connection's field — a crafted connect payload cannot point a broker
 * at an arbitrary stored secret.
 *
 * Must match `BROKER_SECRET_NAMESPACE` in `src/lib/shared/broker-secrets.ts`
 * (a parity test pins it). Changing it orphans every stored broker credential.
 */
export const BROKER_SECRET_NAMESPACE = '6b1d4b8e-3f7a-5c62-9a0e-6f2d1c7e9b44';

export function brokerSecretHandleId(storageKey: string): string {
  return uuidv5(storageKey, BROKER_SECRET_NAMESPACE);
}

export type KafkaSecretField =
  | 'sasl-password'
  | 'oauth-token'
  | 'tls-passphrase'
  | 'registry-password'
  | 'registry-token';

/**
 * Storage key for one Kafka connection credential. Every field name matches a
 * secureStorage sensitive-key pattern (`password`/`token`/`passphrase`), so a
 * legacy pre-handle value lives in the encrypted store, never localStorage.
 */
export function kafkaSecretStorageKey(connectionId: string, field: KafkaSecretField): string {
  return `kafka:${connectionId}:${field}`;
}

/** The handle id a Kafka connection's stored credential field is bound to. */
export function kafkaBoundSecretHandleId(connectionId: string, field: KafkaSecretField): string {
  return brokerSecretHandleId(kafkaSecretStorageKey(connectionId, field));
}
