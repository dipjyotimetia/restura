import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '@/types';

// The refresh request goes through the app's HTTP transport (Worker / Electron
// IPC), never a direct renderer fetch.
const executeProxiedRequestMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
}));

import { refreshOAuth2Auth, shouldRefreshOAuth2 } from '../tokenRefresh';

const baseOauth2Auth = (
  overrides: Partial<NonNullable<AuthConfig['oauth2']>> = {}
): AuthConfig => ({
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

const externalRef = {
  kind: 'external' as const,
  provider: 'aws-secrets-manager' as const,
  profileId: 'prof',
  secretId: 'sid',
};

function tokenResponse(body: Record<string, unknown>) {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: body,
  };
}

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

  it('skips a refresh whose refresh token or client secret is an external-vault reference', () => {
    expect(shouldRefreshOAuth2(baseOauth2Auth({ refreshToken: externalRef }))).toBe(false);
    expect(shouldRefreshOAuth2(baseOauth2Auth({ clientSecret: externalRef }))).toBe(false);
  });

  it('skips a refresh whose refresh token or client secret is a keychain handle', () => {
    const handle = { kind: 'handle' as const, id: 'h' };
    expect(shouldRefreshOAuth2(baseOauth2Auth({ refreshToken: handle }))).toBe(false);
    expect(shouldRefreshOAuth2(baseOauth2Auth({ clientSecret: handle }))).toBe(false);
  });
});

describe('refreshOAuth2Auth', () => {
  beforeEach(() => {
    executeProxiedRequestMock.mockReset();
    executeProxiedRequestMock.mockResolvedValue(
      tokenResponse({
        access_token: 'new-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'new-refresh',
      })
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

  it('sends the refresh through the app HTTP transport, not a renderer fetch', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    try {
      await refreshOAuth2Auth(baseOauth2Auth({ expiresAt: Date.now() + 30_000 }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(globalFetch).not.toHaveBeenCalled();
    expect(executeProxiedRequestMock).toHaveBeenCalledTimes(1);
    const [spec] = executeProxiedRequestMock.mock.calls[0] as [Record<string, unknown>];
    expect(spec).toMatchObject({ method: 'POST', url: 'https://auth.example/token' });
    expect(String(spec.data)).toContain('grant_type=refresh_token');
    expect(String(spec.data)).toContain('refresh_token=refresh-token');
  });

  it('never sends the masked placeholder for an external-vault refresh token', async () => {
    const auth = baseOauth2Auth({ refreshToken: externalRef, expiresAt: Date.now() - 1_000 });
    await expect(refreshOAuth2Auth(auth)).resolves.toBe(auth);
    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });

  it('preserves existing refresh token if provider omits new one', async () => {
    executeProxiedRequestMock.mockResolvedValue(
      tokenResponse({ access_token: 'new-token', token_type: 'Bearer', expires_in: 3600 })
    );
    const auth = baseOauth2Auth({ expiresAt: Date.now() + 30_000 });
    const result = await refreshOAuth2Auth(auth);
    expect(result.oauth2?.refreshToken).toBe('refresh-token');
  });

  it('settles an in-flight token refresh when its owner aborts', async () => {
    executeProxiedRequestMock.mockImplementation(
      (_spec: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const controller = new AbortController();
    const pending = refreshOAuth2Auth(
      baseOauth2Auth({ expiresAt: Date.now() + 30_000 }),
      Date.now(),
      controller.signal
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeProxiedRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://auth.example/token' }),
      expect.objectContaining({ signal: controller.signal })
    );
  });
});
