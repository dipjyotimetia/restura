import type { AuthConfig } from '@/types';

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
 */
export async function applyAuthHeaders(
  auth: AuthConfig,
  headers: Record<string, string>,
  _url: string,
  _method: string,
  _body?: string
): Promise<Record<string, string>> {
  const result = { ...headers };

  switch (auth.type) {
    case 'bearer':
      if (auth.bearer?.token) {
        result['Authorization'] = `Bearer ${auth.bearer.token}`;
      }
      break;

    case 'basic':
      if (auth.basic?.username) {
        result['Authorization'] = `Basic ${btoa(`${auth.basic.username}:${auth.basic.password ?? ''}`)}`;
      }
      break;

    case 'api-key':
      if (auth.apiKey?.key && auth.apiKey?.value) {
        if (auth.apiKey.in === 'header') {
          result[auth.apiKey.key] = auth.apiKey.value;
        }
        // query-param injection is handled at URL-build time, not here
      }
      break;

    case 'oauth2':
      if (auth.oauth2?.accessToken) {
        result['Authorization'] = `${auth.oauth2.tokenType || 'Bearer'} ${auth.oauth2.accessToken}`;
      }
      break;

    // 'aws-signature', 'oauth1', and 'wsse' are signed at wire time inside the
    // proxy (shared/protocol/auth-signer.ts). The renderer passes the auth
    // config through to the proxy spec — see requestExecutor.ts. 'digest' is
    // handled elsewhere (challenge/response, not a single header value).
    case 'aws-signature':
    case 'oauth1':
    case 'wsse':
    case 'digest':
    case 'none':
    default:
      break;
  }

  return result;
}

export function applyApiKeyQueryParam(auth: AuthConfig, params: Record<string, string>): Record<string, string> {
  if (auth.type === 'api-key' && auth.apiKey?.key && auth.apiKey?.value && auth.apiKey.in === 'query') {
    return { ...params, [auth.apiKey.key]: auth.apiKey.value };
  }
  return params;
}
