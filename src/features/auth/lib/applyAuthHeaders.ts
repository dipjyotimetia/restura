import type { AuthConfig } from '@/types';
import { buildAuthCredential } from './buildAuthCredential';

/**
 * Apply auth types whose values DO NOT depend on the wire-byte body or the
 * canonical (post-query-merge) URL — Bearer, Basic, API-key (header), OAuth2.
 *
 * The following auth types are intentionally NOT handled here and are
 * applied at the proxy layer (shared/protocol/auth-signer.ts) so the
 * signature/digest covers the exact bytes the upstream receives:
 *   - `aws-signature`: hashes body bytes; must sign post-body-construction.
 *   - `oauth1`: signature includes URL+method (and body for form-encoded
 *     POSTs); the proxy may add params.
 *   - `wsse`: independent of body, but lives next to the others to keep
 *     the auth pipeline centralised.
 *
 * The renderer passes the raw `auth` object through to the proxy spec instead.
 *
 * Common credential building (Basic / Bearer / API-Key / OAuth2) is shared
 * with gRPC via `buildAuthCredential` — see `./buildAuthCredential.ts`.
 */
export async function applyAuthHeaders(
  auth: AuthConfig,
  headers: Record<string, string>,
  _url: string,
  _method: string,
  _body?: string
): Promise<Record<string, string>> {
  const credential = buildAuthCredential(auth);
  return { ...headers, ...credential.headers };
}

export function applyApiKeyQueryParam(auth: AuthConfig, params: Record<string, string>): Record<string, string> {
  const credential = buildAuthCredential(auth);
  if (Object.keys(credential.params).length === 0) return params;
  return { ...params, ...credential.params };
}
