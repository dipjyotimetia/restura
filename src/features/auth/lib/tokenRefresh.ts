import type { AuthConfig } from '@/types';
import { fetchRefreshToken, tokenExpiresAt } from './oauth2';

const REFRESH_SKEW_MS = 60_000;

export function shouldRefreshOAuth2(auth: AuthConfig, nowMs = Date.now()): boolean {
  if (auth.type !== 'oauth2') return false;
  const o = auth.oauth2;
  if (!o?.refreshToken || !o.tokenUrl || !o.clientId) return false;
  if (!o.expiresAt) return false;
  return o.expiresAt - nowMs <= REFRESH_SKEW_MS;
}

export async function refreshOAuth2Auth(auth: AuthConfig, nowMs = Date.now()): Promise<AuthConfig> {
  if (!shouldRefreshOAuth2(auth, nowMs)) return auth;
  // shouldRefreshOAuth2 validates refreshToken, tokenUrl, clientId and expiresAt presence
  const o = auth.oauth2!;
  const res = await fetchRefreshToken({
    clientId: o.clientId!,
    clientSecret: o.clientSecret,
    tokenUrl: o.tokenUrl!,
    refreshToken: o.refreshToken!,
    scope: o.scope,
  });
  return {
    ...auth,
    oauth2: {
      ...o,
      accessToken: res.access_token,
      tokenType: res.token_type ?? o.tokenType,
      refreshToken: res.refresh_token ?? o.refreshToken,
      expiresAt: tokenExpiresAt(nowMs, res.expires_in) ?? o.expiresAt,
    },
  };
}
