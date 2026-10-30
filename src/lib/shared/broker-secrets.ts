/**
 * Broker (Kafka / MQTT) credentials as main-process secret handles (ADR-0007).
 *
 * Every stored broker secret is keyed by a storage key such as
 * `mqtt:<connectionId>:password` or `kafka:preset-<requestId>:sasl-password`.
 * The plaintext lives in the main-process secret-handle store under a
 * deterministic UUIDv5 derived from that key, so the renderer can reference it
 * as `{ kind: 'handle', id }` on the connect IPC and copy it between scopes
 * (connection ↔ preset) without ever reading the value back.
 *
 * Older builds kept these values in `secureStorage` (encrypted electron-store,
 * read back into the renderer on every connect). {@link ensureBrokerSecret}
 * migrates such a value into a handle once, then deletes the legacy copy.
 */

import { brokerSecretHandleId } from '@shared/protocol/broker-secret-id';
import { handleSecret, type SecretRef } from './secretRef';
import { secureStorage } from './secure-storage';

export { brokerSecretHandleId };

/** The `SecretRef` sent over IPC in place of the plaintext. */
export function brokerSecretRef(storageKey: string): SecretRef {
  return handleSecret(brokerSecretHandleId(storageKey));
}

function secretsApi() {
  const api = typeof window === 'undefined' ? undefined : window.electron?.secrets;
  if (!api) throw new Error('Secure secret storage is unavailable');
  return api;
}

/** Store (or overwrite) the secret for `storageKey`. */
export async function putBrokerSecret(
  storageKey: string,
  value: string,
  label?: string
): Promise<void> {
  const result = await secretsApi().store({
    id: brokerSecretHandleId(storageKey),
    value,
    ...(label ? { label } : {}),
  });
  if (!result.ok) throw new Error(result.error);
  // A legacy copy must never shadow (or outlive) the handle.
  secureStorage.remove(storageKey);
}

/** Delete the secret for `storageKey` (handle and any legacy copy). */
export async function removeBrokerSecret(storageKey: string): Promise<void> {
  secureStorage.remove(storageKey);
  await secretsApi().delete(brokerSecretHandleId(storageKey));
}

/**
 * True when a secret is stored for `storageKey`. A value still held in the
 * legacy `secureStorage` slot is moved into a handle first (one-time
 * migration — the only point the renderer still sees that plaintext).
 */
export async function ensureBrokerSecret(storageKey: string, label?: string): Promise<boolean> {
  const api = secretsApi();
  const described = await api.describe(brokerSecretHandleId(storageKey));
  if (described.ok && described.handle) return true;
  const legacy = await secureStorage.getAsync(storageKey);
  if (!legacy) return false;
  await putBrokerSecret(storageKey, legacy, label);
  return true;
}

/**
 * Copy the secret stored for `fromKey` to `toKey` entirely in main. When
 * nothing is stored for `fromKey`, any secret at `toKey` is removed so a
 * re-save never keeps a stale credential. Returns whether a value was copied.
 */
export async function copyBrokerSecret(
  fromKey: string,
  toKey: string,
  label?: string
): Promise<boolean> {
  if (!(await ensureBrokerSecret(fromKey, label))) {
    await removeBrokerSecret(toKey);
    return false;
  }
  const result = await secretsApi().copy({
    from: brokerSecretHandleId(fromKey),
    to: brokerSecretHandleId(toKey),
    ...(label ? { label } : {}),
  });
  if (!result.ok) throw new Error(result.error);
  if (result.copied) secureStorage.remove(toKey);
  return result.copied;
}
