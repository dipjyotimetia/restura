import { isSecretHandle, unwrapSecret } from '@/lib/shared/secretRef';
import type { AuthConfig } from '@/types';

export interface AuthCredential {
  /**
   * Header name → value pairs. For HTTP these become request headers; for
   * gRPC, metadata entries.
   */
  headers: Record<string, string>;
  /** Query params (only populated for `api-key` with `in: 'query'`). */
  params: Record<string, string>;
  /**
   * True when the auth descriptor carries a SecretRef handle that the
   * renderer cannot resolve to plaintext (handles are main-process-only per
   * ADR-0007). The executor uses this marker to skip the renderer-side
   * Authorization header and let the Electron HTTP handler resolve+apply
   * main-side. On web, the executor fails fast with a user-visible error.
   */
  requiresMainSideApply?: boolean;
}

export interface BuildAuthCredentialOptions {
  /**
   * `'preserve'` keeps user-supplied casing on auth headers (HTTP convention,
   * matches what Postman/Insomnia send: `Authorization`, `X-API-Key`, ...).
   * `'lower'` lowercases the standard `authorization` header and any api-key
   * header — required by gRPC, where metadata keys are case-insensitive but
   * canonically lowercased.
   */
  headerCase?: 'preserve' | 'lower';
  /**
   * If true, Basic auth requires BOTH username AND password to be truthy
   * before emitting a credential. Defaults to false (HTTP semantics — we
   * allow empty passwords because RFC 7617 permits them and several
   * APIs use the username slot for an opaque token).
   */
  basicRequiresPassword?: boolean;
}

/**
 * Build the wire credential for the AuthConfig types that don't need
 * protocol-specific signing (Basic, Bearer, OAuth2, API-Key). Returns empty
 * collections for `none` and for the sign-at-wire types (`digest`, `oauth1`,
 * `aws-signature`, `ntlm`, `wsse`) — the caller is responsible for those
 * because they require body bytes, challenge/response, or canonicalised URLs
 * the renderer doesn't have at this stage.
 *
 * SecretRef-aware (ADR-0007): if any sensitive field is a handle, the
 * credential is left empty and `requiresMainSideApply: true` is returned so
 * the executor knows to defer to Electron's HTTP handler. Inline + plain
 * string values are unwrapped synchronously.
 */
export function buildAuthCredential(
  auth: AuthConfig | undefined,
  options: BuildAuthCredentialOptions = {}
): AuthCredential {
  const empty: AuthCredential = { headers: {}, params: {} };
  if (!auth || auth.type === 'none') return empty;

  const lower = options.headerCase === 'lower';
  const authzKey = lower ? 'authorization' : 'Authorization';

  switch (auth.type) {
    case 'bearer': {
      if (isSecretHandle(auth.bearer?.token)) {
        return { ...empty, requiresMainSideApply: true };
      }
      const token = unwrapSecret(auth.bearer?.token);
      if (!token) return empty;
      return { headers: { [authzKey]: `Bearer ${token}` }, params: {} };
    }

    case 'basic': {
      if (isSecretHandle(auth.basic?.password)) {
        return { ...empty, requiresMainSideApply: true };
      }
      const username = auth.basic?.username ?? '';
      const password = unwrapSecret(auth.basic?.password);
      if (options.basicRequiresPassword) {
        if (!username || !password) return empty;
      } else if (!username) {
        return empty;
      }
      const credentials = btoa(`${username}:${password}`);
      return { headers: { [authzKey]: `Basic ${credentials}` }, params: {} };
    }

    case 'api-key': {
      if (isSecretHandle(auth.apiKey?.value)) {
        return { ...empty, requiresMainSideApply: true };
      }
      const key = auth.apiKey?.key ?? '';
      const value = unwrapSecret(auth.apiKey?.value);
      const where = auth.apiKey?.in ?? 'header';
      if (!key || !value) return empty;
      if (where === 'query') {
        return { headers: {}, params: { [key]: value } };
      }
      const headerKey = lower ? key.toLowerCase() : key;
      return { headers: { [headerKey]: value }, params: {} };
    }

    case 'oauth2': {
      if (isSecretHandle(auth.oauth2?.accessToken)) {
        return { ...empty, requiresMainSideApply: true };
      }
      const token = unwrapSecret(auth.oauth2?.accessToken);
      if (!token) return empty;
      const tokenType = auth.oauth2?.tokenType || 'Bearer';
      return { headers: { [authzKey]: `${tokenType} ${token}` }, params: {} };
    }

    // Sign-at-wire types: caller handles these (digest challenge/response,
    // oauth1/aws-signature need body+URL bytes, ntlm is desktop-only,
    // wsse is signed in the proxy).
    case 'digest':
    case 'oauth1':
    case 'aws-signature':
    case 'ntlm':
    case 'wsse':
    default:
      return empty;
  }
}
