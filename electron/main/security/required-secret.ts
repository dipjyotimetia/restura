import type { SecretResolver } from '@shared/protocol/auth-signer';
import { unwrapSecretValueMain } from './secret-handle-store';

/**
 * Thrown when a configured credential cannot be read in Electron main — a
 * keychain handle that is missing or revoked on this device, or an external
 * reference that was not materialised. The request must fail; sending it
 * without the credential (or signing with an empty secret) is what the Worker
 * (`inlineOnlySecretResolver`) and the CLI (`secretString`) refuse too. The
 * message names the field, never a value or handle id.
 */
export class SecretUnavailableError extends Error {
  constructor(what = 'Auth credential') {
    super(`${what} is unavailable on this device`);
    this.name = 'SecretUnavailableError';
  }
}

/**
 * Resolve a `SecretValue` to plaintext in main, or throw
 * {@link SecretUnavailableError}. An absent field (`undefined`/`null`) stays
 * `undefined` — that is "not configured", not "unavailable".
 */
export function requireSecretValueMain(value: unknown, what?: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const plaintext = unwrapSecretValueMain(value);
  if (plaintext === undefined) throw new SecretUnavailableError(what);
  return plaintext;
}

/**
 * Desktop `resolveSecret` for the shared sign-at-wire pipeline (SigV4, OAuth1,
 * WSSE, Digest): an absent field is `''` (the signer validates required ones),
 * an unresolvable one throws.
 */
export const requiredSecretResolver: SecretResolver = (value) =>
  requireSecretValueMain(value) ?? '';
