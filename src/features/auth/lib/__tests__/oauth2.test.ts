import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchRefreshToken,
  fetchClientCredentialsToken,
  tokenExpiresAt,
  OAuth2TokenError,
} from '../oauth2';

const mockTokenResponse = {
  access_token: 'next-token',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'refresh-next',
};

const baseConfig = {
  grantType: 'authorization_code' as const,
  clientId: 'client',
  authorizationUrl: 'https://auth.example/authorize',
  tokenUrl: 'https://auth.example/token',
  redirectUri: 'https://app.example/callback',
  scope: 'read write',
};

describe('buildAuthorizationUrl', () => {
  it('builds authorization URL with PKCE challenge and state', async () => {
    const result = await buildAuthorizationUrl(baseConfig);

    const url = new URL(result.url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/callback');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(result.codeVerifier.length).toBeGreaterThan(30);
  });

  it('throws when authorizationUrl is missing', async () => {
    await expect(
      buildAuthorizationUrl({ ...baseConfig, authorizationUrl: undefined })
    ).rejects.toThrow('Authorization URL is required');
  });

  it('throws when redirectUri is missing', async () => {
    await expect(buildAuthorizationUrl({ ...baseConfig, redirectUri: undefined })).rejects.toThrow(
      'Redirect URI is required'
    );
  });

  it('includes scope when provided', async () => {
    const result = await buildAuthorizationUrl({ ...baseConfig, scope: 'openid profile' });
    const url = new URL(result.url);
    expect(url.searchParams.get('scope')).toBe('openid profile');
  });
});

describe('exchangeCodeForToken', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(mockTokenResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
  });

  it('sends code_verifier in exchange request', async () => {
    await exchangeCodeForToken(baseConfig, 'auth-code', 'my-verifier');

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code');
    expect(body).toContain('code_verifier=my-verifier');
  });

  it('throws when redirectUri is missing', async () => {
    await expect(
      exchangeCodeForToken({ ...baseConfig, redirectUri: undefined }, 'code', 'verifier')
    ).rejects.toThrow('Redirect URI is required');
  });
});

describe('fetchRefreshToken', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(mockTokenResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
  });

  it('sends grant_type=refresh_token', async () => {
    await fetchRefreshToken({
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      refreshToken: 'refresh-old',
    });

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-old');
    expect(body).toContain('client_id=client');
  });

  it('includes client_secret when provided', async () => {
    await fetchRefreshToken({
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      refreshToken: 'refresh-old',
      clientSecret: 'secret',
    });

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('client_secret=secret');
  });

  it('returns token response on success', async () => {
    const result = await fetchRefreshToken({
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      refreshToken: 'refresh-old',
    });

    expect(result.access_token).toBe('next-token');
    expect(result.refresh_token).toBe('refresh-next');
  });
});

describe('fetchClientCredentialsToken', () => {
  it('throws OAuth2TokenError on error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'invalid_client', error_description: 'Bad credentials' }),
            { status: 401, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    await expect(
      fetchClientCredentialsToken({
        grantType: 'client_credentials',
        clientId: 'bad-client',
        tokenUrl: 'https://auth.example/token',
      })
    ).rejects.toThrow(OAuth2TokenError);
  });
});

describe('fetchPasswordToken', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(mockTokenResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
  });

  it('throws when username is missing', async () => {
    const { fetchPasswordToken } = await import('../oauth2');
    await expect(
      fetchPasswordToken({
        grantType: 'password',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
        username: '',
        password: 'pass',
      })
    ).rejects.toThrow('Username and password are required');
  });

  it('sends grant_type=password with credentials', async () => {
    const { fetchPasswordToken } = await import('../oauth2');
    await fetchPasswordToken({
      grantType: 'password',
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      username: 'user',
      password: 'pass',
    });

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('grant_type=password');
    expect(body).toContain('username=user');
    expect(body).toContain('password=pass');
  });
});

describe('fetchDeviceCode', () => {
  it('throws when deviceAuthorizationUrl is missing', async () => {
    const { fetchDeviceCode } = await import('../oauth2');
    await expect(
      fetchDeviceCode({
        grantType: 'device_code',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
      })
    ).rejects.toThrow('Device Authorization URL is required');
  });

  it('sends device code request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              device_code: 'device-abc',
              user_code: 'ABCD-1234',
              verification_uri: 'https://device.example/activate',
              expires_in: 300,
              interval: 5,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    const { fetchDeviceCode } = await import('../oauth2');
    const result = await fetchDeviceCode({
      grantType: 'device_code',
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      deviceAuthorizationUrl: 'https://auth.example/device_authorization',
    });

    expect(result.device_code).toBe('device-abc');
    expect(result.user_code).toBe('ABCD-1234');
  });

  it('throws on non-ok response from device endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } })
      )
    );

    const { fetchDeviceCode } = await import('../oauth2');
    await expect(
      fetchDeviceCode({
        grantType: 'device_code',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
        deviceAuthorizationUrl: 'https://auth.example/device_authorization',
      })
    ).rejects.toThrow('Device code request failed');
  });
});

describe('pollForDeviceToken', () => {
  it('throws timed out when max attempts reached with 0s interval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'authorization_pending' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const { pollForDeviceToken } = await import('../oauth2');
    await expect(
      pollForDeviceToken(
        { grantType: 'device_code', clientId: 'client', tokenUrl: 'https://auth.example/token' },
        'device-code-abc',
        0, // 0 second interval avoids slow real timers
        1 // only 1 attempt
      )
    ).rejects.toThrow('timed out');
  });

  it('terminates on non-pending errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'access_denied' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const { pollForDeviceToken } = await import('../oauth2');
    await expect(
      pollForDeviceToken(
        { grantType: 'device_code', clientId: 'client', tokenUrl: 'https://auth.example/token' },
        'device-code-abc',
        0,
        3
      )
    ).rejects.toThrow();
  });
});

describe('tokenExpiresAt', () => {
  it('computes expiry timestamp from now + seconds', () => {
    const now = 1_000_000;
    expect(tokenExpiresAt(now, 3600)).toBe(now + 3_600_000);
  });

  it('returns undefined when expiresInSeconds is falsy', () => {
    expect(tokenExpiresAt(Date.now(), undefined)).toBeUndefined();
    expect(tokenExpiresAt(Date.now(), 0)).toBeUndefined();
  });
});
