import { describe, expect, it, vi, beforeEach } from 'vitest';
import { shouldRefreshOAuth2, refreshOAuth2Auth } from '../tokenRefresh';
import type { AuthConfig } from '@/types';

const baseOauth2Auth = (overrides: Partial<NonNullable<AuthConfig['oauth2']>> = {}): AuthConfig => ({
  type: 'oauth2',
  oauth2: {
    accessToken: 'old-token',
    tokenType: 'Bearer',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 30_000, // expires in 30s — within skew window
    tokenUrl: 'https://auth.example/token',
    clientId: 'client-id',
    ...overrides,
  },
});

describe('shouldRefreshOAuth2', () => {
  it('returns false for non-oauth2 auth', () => {
    expect(shouldRefreshOAuth2({ type: 'bearer', bearer: { token: 'tok' } })).toBe(false);
  });

  it('returns false when refreshToken is missing', () => {
    const auth = baseOauth2Auth({ refreshToken: undefined });
    expect(shouldRefreshOAuth2(auth)).toBe(false);
  });

  it('returns false when expiresAt is missing', () => {
    const auth = baseOauth2Auth({ expiresAt: undefined });
    expect(shouldRefreshOAuth2(auth)).toBe(false);
  });

  it('returns false when token is not near expiry', () => {
    const auth = baseOauth2Auth({ expiresAt: Date.now() + 120_000 });
    expect(shouldRefreshOAuth2(auth)).toBe(false);
  });

  it('returns true when token expires within skew window (60s)', () => {
    const auth = baseOauth2Auth({ expiresAt: Date.now() + 30_000 });
    expect(shouldRefreshOAuth2(auth)).toBe(true);
  });

  it('returns true when token is already expired', () => {
    const auth = baseOauth2Auth({ expiresAt: Date.now() - 1_000 });
    expect(shouldRefreshOAuth2(auth)).toBe(true);
  });
});

describe('refreshOAuth2Auth', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'new-refresh',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
  });

  it('returns auth unchanged when refresh not needed', async () => {
    const auth = baseOauth2Auth({ expiresAt: Date.now() + 120_000 });
    const result = await refreshOAuth2Auth(auth);
    expect(result).toBe(auth);
  });

  it('refreshes token and returns updated auth when near expiry', async () => {
    const auth = baseOauth2Auth({ expiresAt: Date.now() + 30_000 });
    const result = await refreshOAuth2Auth(auth);
    expect(result.oauth2?.accessToken).toBe('new-token');
    expect(result.oauth2?.refreshToken).toBe('new-refresh');
    expect(result.oauth2?.expiresAt).toBeGreaterThan(Date.now() + 3_590_000);
  });

  it('preserves existing refresh token if provider omits new one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'new-token', token_type: 'Bearer', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    const auth = baseOauth2Auth({ expiresAt: Date.now() + 30_000 });
    const result = await refreshOAuth2Auth(auth);
    expect(result.oauth2?.refreshToken).toBe('refresh-token');
  });
});
