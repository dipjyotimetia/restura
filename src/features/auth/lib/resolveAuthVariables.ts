import type { SecretValue } from '@/lib/shared/secretRef';
import type { AuthConfig } from '@/types';

/**
 * Resolve `{{vars}}` in the credential fields of the header-shaped auth types
 * (Basic, Bearer, API Key, OAuth 2.0 access token). Plain strings and inline
 * SecretRefs are resolved; handle / external SecretRefs are opaque to the
 * renderer (ADR-0007) and pass through untouched for Electron main to resolve.
 *
 * Other auth types are returned as-is. Returns the same object when nothing
 * changed so callers can cheaply detect a no-op.
 */
export function resolveAuthVariables(
  auth: AuthConfig,
  resolve: (text: string) => string
): AuthConfig {
  const secret = (value: SecretValue | undefined): SecretValue | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return resolve(value);
    if (value.kind === 'inline') return { kind: 'inline', value: resolve(value.value) };
    return value;
  };

  switch (auth.type) {
    case 'bearer':
      if (!auth.bearer) return auth;
      return { ...auth, bearer: { token: secret(auth.bearer.token) ?? '' } };
    case 'basic':
      if (!auth.basic) return auth;
      return {
        ...auth,
        basic: {
          username: resolve(auth.basic.username),
          password: secret(auth.basic.password) ?? '',
        },
      };
    case 'api-key':
      if (!auth.apiKey) return auth;
      return {
        ...auth,
        apiKey: {
          ...auth.apiKey,
          key: resolve(auth.apiKey.key),
          value: secret(auth.apiKey.value) ?? '',
        },
      };
    case 'oauth2':
      if (!auth.oauth2) return auth;
      return {
        ...auth,
        oauth2: {
          ...auth.oauth2,
          accessToken: secret(auth.oauth2.accessToken) ?? '',
          ...(auth.oauth2.tokenType !== undefined
            ? { tokenType: resolve(auth.oauth2.tokenType) }
            : {}),
        },
      };
    default:
      return auth;
  }
}
