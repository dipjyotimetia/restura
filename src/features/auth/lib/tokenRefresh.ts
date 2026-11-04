import { unwrapSecret } from '@/lib/shared/secretRef';
import type { AuthConfig } from '@/types';
import { fetchRefreshToken, tokenExpiresAt } from './oauth2';
import { proxiedTokenFetch } from './oauth2-transport';
import { isRendererReadableSecret } from './readableSecret';

const REFRESH_SKEW_MS = 60_000;

export function shouldRefreshOAuth2(auth: AuthConfig, nowMs = Date.now()): boolean {
  if (auth.type !== 'oauth2') return false;
  const o = auth.oauth2;
  if (!o?.refreshToken || !o.tokenUrl || !o.clientId) return false;
  if (!o.expiresAt) return false;
  // The renderer cannot refresh against a keychain handle or an external-vault
  // reference — plaintext lives only in the main process / the vault, and the
  // renderer would read a masked placeholder. Skip refresh; the expired token
  // surfaces a 401 from upstream, the same UX as when refresh isn't configured.
  if (!isRendererReadableSecret(o.refreshToken) || !isRendererReadableSecret(o.clientSecret)) {
    return false;
  }
  return o.expiresAt - nowMs <= REFRESH_SKEW_MS;
}

export async function refreshOAuth2Auth(
  auth: AuthConfig,
  nowMs = Date.now(),
  signal?: AbortSignal
): Promise<AuthConfig> {
  if (!shouldRefreshOAuth2(auth, nowMs)) return auth;
  // shouldRefreshOAuth2 validates refreshToken, tokenUrl, clientId and expiresAt presence
  const o = auth.oauth2!;
  const refreshTokenStr = unwrapSecret(o.refreshToken);
  const clientSecretStr = o.clientSecret !== undefined ? unwrapSecret(o.clientSecret) : undefined;
  const res = await fetchRefreshToken(
    {
      clientId: o.clientId!,
      tokenUrl: o.tokenUrl!,
      refreshToken: refreshTokenStr,
      ...(clientSecretStr !== undefined &&
        clientSecretStr !== '' && { clientSecret: clientSecretStr }),
      ...(o.scope !== undefined && { scope: o.scope }),
      fetch: proxiedTokenFetch,
    },
    signal
  );
  const tokenType = res.token_type ?? o.tokenType;
  const refreshToken = res.refresh_token ?? refreshTokenStr;
  const expiresAt = tokenExpiresAt(nowMs, res.expires_in) ?? o.expiresAt;
  return {
    ...auth,
    oauth2: {
      ...o,
      accessToken: res.access_token,
      ...(tokenType !== undefined && { tokenType }),
      ...(refreshToken !== undefined && { refreshToken }),
      ...(expiresAt !== undefined && { expiresAt }),
    },
  };
}

/**
 * Fold a refresh result back onto the user's *template* auth for persistence.
 *
 * The executor refreshes against a `{{var}}`-resolved copy of the auth, so the
 * refreshed object carries resolved plaintext in every templated field
 * (clientId, tokenUrl, a `{{refresh}}` token, …). Persisting that would bake
 * variable values — often environment secrets — into the saved request. Only
 * what the token endpoint issued is taken from `refreshed`: the access token,
 * expiry, and a refresh token / token type only when the server rotated them
 * (they differ from the resolved inputs). Everything else keeps the template.
 */
export function persistableRefreshedAuth(
  template: AuthConfig,
  resolved: AuthConfig,
  refreshed: AuthConfig
): AuthConfig {
  const t = template.oauth2;
  const r = resolved.oauth2;
  const n = refreshed.oauth2;
  if (template.type !== 'oauth2' || !t || !r || !n) return template;
  const resolvedRefresh = r.refreshToken !== undefined ? unwrapSecret(r.refreshToken) : undefined;
  const rotatedRefresh =
    n.refreshToken !== undefined && unwrapSecret(n.refreshToken) !== resolvedRefresh;
  const serverTokenType = n.tokenType !== undefined && n.tokenType !== r.tokenType;
  return {
    ...template,
    oauth2: {
      ...t,
      accessToken: n.accessToken,
      ...(n.expiresAt !== undefined && { expiresAt: n.expiresAt }),
      ...(rotatedRefresh && n.refreshToken !== undefined && { refreshToken: n.refreshToken }),
      ...(serverTokenType && n.tokenType !== undefined && { tokenType: n.tokenType }),
    },
  };
}
