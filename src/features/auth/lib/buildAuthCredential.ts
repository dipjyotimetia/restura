import {
  type AuthCredential,
  type AuthCredentialOptions,
  buildAuthCredential as buildCredential,
  type CredentialHost,
  DEFERRED_SECRET,
} from '@shared/protocol/request-spec';
import { isExternalSecretRef, isSecretHandle, unwrapSecret } from '@/lib/shared/secretRef';
import type { AuthConfig } from '@/types';

export type { AuthCredential };
export type BuildAuthCredentialOptions = AuthCredentialOptions;

/**
 * Handles and external refs are never readable in the renderer (ADR-0007): they
 * are deferred, and the executor lets Electron's HTTP handler resolve and apply
 * them main-side. On web, the executor fails fast with a user-visible error.
 */
const RENDERER_HOST: CredentialHost = {
  readSecret: (value) =>
    isSecretHandle(value) || isExternalSecretRef(value) ? DEFERRED_SECRET : unwrapSecret(value),
  encodeBasic: (credentials) => btoa(credentials),
};

/**
 * Build the wire credential for the AuthConfig types that don't need
 * protocol-specific signing (Basic, Bearer, OAuth2, API-Key). The rule itself is
 * shared with the CLI (`shared/protocol/request-spec.ts`); this binds it to the
 * renderer's Secret access. Returns empty collections for `none` and for the
 * sign-at-wire types, and `requiresMainSideApply: true` for a deferred secret.
 */
export function buildAuthCredential(
  auth: AuthConfig | undefined,
  options: BuildAuthCredentialOptions = {}
): AuthCredential {
  return buildCredential(auth, RENDERER_HOST, options);
}
