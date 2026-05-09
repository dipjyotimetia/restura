import type { AuthConfig } from '@/types';

/**
 * Apply auth types whose values DO NOT depend on the wire-byte body —
 * Bearer, Basic, API-key (header), OAuth2.
 *
 * AWS SigV4 is intentionally NOT handled here: it hashes the body bytes,
 * so it must be signed inside the proxy (shared/protocol/auth-signer.ts)
 * against the exact bytes the upstream receives. The renderer passes the
 * raw `auth` object through to the proxy spec instead.
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

    // 'aws-signature' is signed at wire time inside the proxy. The renderer
    // passes the auth config through to the proxy spec — see requestExecutor.ts.
    case 'aws-signature':
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
