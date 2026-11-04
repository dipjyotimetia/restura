import { isExternalSecretRef, isSecretHandle, type SecretValue } from '@/lib/shared/secretRef';

/**
 * Whether the renderer can read this secret's plaintext. A keychain handle or
 * an external-vault reference is opaque here (ADR-0007): `unwrapSecret` would
 * return a masked placeholder, which must never be sent anywhere. Absent
 * counts as readable (there is simply nothing to send).
 */
export function isRendererReadableSecret(value: SecretValue | undefined): boolean {
  return !isSecretHandle(value) && !isExternalSecretRef(value);
}
