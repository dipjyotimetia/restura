/**
 * Main-process auth applier for non-sign-at-wire auth types (basic, bearer,
 * api-key, oauth2). When the renderer's `AuthConfig` carries a `SecretRef`
 * with `kind:'handle'`, the renderer cannot read plaintext and skips applying
 * the Authorization header. The Electron HTTP handler calls this helper to
 * resolve the handle main-side and emit the header/query before dispatching.
 *
 * The remaining types (aws-signature, oauth1, wsse, ntlm, digest) are handled
 * downstream — most by `shared/protocol/auth-signer.ts` via the `resolveSecret`
 * option threaded through `executeHttpProxy`. This helper returns nothing for
 * them.
 */

import type { ProtocolAuthConfig } from '@shared/protocol/types';
import { unwrapSecretValueMain } from './secret-handle-store';

type AnyAuth = ProtocolAuthConfig & {
  basic?: { username: string; password: unknown };
  bearer?: { token: unknown };
  apiKey?: { key: string; value: unknown; in: 'header' | 'query' };
  oauth2?: { accessToken: unknown; tokenType?: string };
};

export interface AppliedCredentials {
  headers: Record<string, string>;
  params: Record<string, string>;
}

/**
 * Build header/query contributions for the non-sign-at-wire auth descriptors.
 * Returns empty collections for `none` and for sign-at-wire types (those are
 * applied later by `applyAuth` inside `executeHttpProxy`).
 */
export function applyNonSignAtWireAuth(auth: AnyAuth | undefined): AppliedCredentials {
  const empty: AppliedCredentials = { headers: {}, params: {} };
  if (!auth || auth.type === 'none') return empty;

  switch (auth.type) {
    case 'bearer': {
      const token = unwrapSecretValueMain(auth.bearer?.token) ?? '';
      if (!token) return empty;
      return { headers: { Authorization: `Bearer ${token}` }, params: {} };
    }
    case 'basic': {
      const username = auth.basic?.username ?? '';
      const password = unwrapSecretValueMain(auth.basic?.password) ?? '';
      if (!username) return empty;
      const credentials = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      return { headers: { Authorization: `Basic ${credentials}` }, params: {} };
    }
    case 'api-key': {
      const key = auth.apiKey?.key ?? '';
      const value = unwrapSecretValueMain(auth.apiKey?.value) ?? '';
      const where = auth.apiKey?.in ?? 'header';
      if (!key || !value) return empty;
      return where === 'query'
        ? { headers: {}, params: { [key]: value } }
        : { headers: { [key]: value }, params: {} };
    }
    case 'oauth2': {
      const token = unwrapSecretValueMain(auth.oauth2?.accessToken) ?? '';
      if (!token) return empty;
      const tokenType = auth.oauth2?.tokenType || 'Bearer';
      return { headers: { Authorization: `${tokenType} ${token}` }, params: {} };
    }
    // Sign-at-wire types — caller's `executeHttpProxy(resolveSecret)` handles these.
    case 'digest':
    case 'oauth1':
    case 'aws-signature':
    case 'ntlm':
    case 'wsse':
    default:
      return empty;
  }
}

/**
 * The sign-at-wire types above are only actually signed for HTTP, via
 * `shared/protocol/auth-signer.ts`'s `resolveSecret` option threaded through
 * `executeHttpProxy`. gRPC's metadata-based transport has no equivalent
 * signer, so `applyNonSignAtWireAuth` silently returning `{}` for these means
 * "no credentials at all" rather than "handled elsewhere" when the caller is
 * gRPC. Callers on the gRPC path (unary/streaming requests and reflection)
 * should check this before proceeding, and fail clearly instead of sending
 * the request unauthenticated.
 */
const GRPC_UNSUPPORTED_AUTH_TYPES = new Set(['digest', 'oauth1', 'aws-signature', 'ntlm', 'wsse']);

/**
 * Returns a user-facing explanation when `auth` is a type gRPC cannot apply
 * credentials for, or `null` when it's fine to proceed. `subject` fills the
 * tail of the message per call site (e.g. "the request", "the stream").
 */
export function describeUnsupportedGrpcAuth(
  auth: { type?: string } | undefined,
  subject: string
): string | null {
  if (!auth?.type || !GRPC_UNSUPPORTED_AUTH_TYPES.has(auth.type)) return null;
  return (
    `[Auth] "${auth.type}" authentication is not supported for gRPC — ${subject} would ` +
    `otherwise be sent with no credentials. Use Bearer, Basic, API Key, or OAuth2 instead.`
  );
}
