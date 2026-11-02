// @vitest-environment jsdom
// A value from a token endpoint is stored in an auth field as written text, so it
// must not hold a variable token (ADR-0007). The flow fails with no value shown.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxied = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => proxied(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));
vi.mock('@/features/auth/lib/oauth2-popup', () => ({
  authorizeWithPopup: vi.fn(async () => ({ code: 'auth-code' })),
}));

import { OAuth2AuthEditor } from '../../src/features/auth/components/editors/OAuth2AuthEditor';
import { buildAuthCredential } from '../../src/features/auth/lib/buildAuthCredential';
import { fetchClientCredentialsToken } from '../../src/features/auth/lib/oauth2';
import { refreshOAuth2Auth } from '../../src/features/auth/lib/tokenRefresh';
import { executeRequest } from '../../src/features/http/lib/requestExecutor';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import type { AuthConfig } from '../../src/types';

const REFUSAL = /variable reference/;

function tokenEndpoint(body: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const payload = String(input).endsWith('/device')
      ? {
          device_code: 'd',
          user_code: 'u',
          verification_uri: 'https://a.test/v',
          expires_in: 60,
          interval: 0,
        }
      : body;
    return new Response(JSON.stringify(payload), { status: 200 });
  });
}

const auth = (grantType: string): AuthConfig =>
  ({
    type: 'oauth2',
    oauth2: {
      accessToken: '',
      grantType,
      clientId: 'client',
      tokenUrl: 'https://a.test/token',
      authorizationUrl: 'https://a.test/authorize',
      deviceAuthorizationUrl: 'https://a.test/device',
      redirectUri: 'https://a.test/callback',
      username: 'u',
      password: 'p',
    },
  }) as AuthConfig;

const BAD_RESPONSES: Array<[string, Record<string, unknown>]> = [
  ['access_token', { access_token: '{{sec}}', token_type: 'Bearer' }],
  ['padded access_token', { access_token: 'a{{ sec }}b' }],
  ['token_type', { access_token: 'ok', token_type: '{{sec}}' }],
  ['refresh_token', { access_token: 'ok', refresh_token: '{{sec}}' }],
  ['a token split across fields', { access_token: '}}', token_type: '{{sec' }],
  ['an opening pair', { access_token: 'a{{b' }],
  ['a closing pair', { access_token: 'a}}b' }],
];
const GRANTS = ['client_credentials', 'password', 'authorization_code', 'device_code'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Get New Access Token', () => {
  for (const grant of GRANTS) {
    for (const [field, response] of BAD_RESPONSES) {
      it(`does not store ${field} holding a variable token (${grant})`, async () => {
        tokenEndpoint(response);
        const onChange = vi.fn();
        render(<OAuth2AuthEditor auth={auth(grant)} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: /Get New Access Token/ }));
        const shown = await screen.findByText(REFUSAL);
        expect(shown.textContent).not.toContain('{{');
        expect(onChange).not.toHaveBeenCalled();
      });
    }

    it(`stores an ordinary token (${grant})`, async () => {
      tokenEndpoint({ access_token: 'ordinary', token_type: 'Bearer' });
      const onChange = vi.fn();
      render(<OAuth2AuthEditor auth={auth(grant)} onChange={onChange} />);
      fireEvent.click(screen.getByRole('button', { name: /Get New Access Token/ }));
      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      expect(onChange.mock.calls[0]?.[0].oauth2.accessToken).toEqual({
        kind: 'inline',
        value: 'ordinary',
      });
    });
  }
});

describe('token refresh', () => {
  const expiring: AuthConfig = {
    type: 'oauth2',
    oauth2: {
      accessToken: 'old',
      refreshToken: 'old-refresh',
      clientId: 'client',
      tokenUrl: 'https://a.test/token',
      expiresAt: 1,
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  for (const [field, response] of BAD_RESPONSES) {
    it(`refuses ${field} holding a variable token`, async () => {
      tokenEndpoint(response);
      const error = await refreshOAuth2Auth(expiring, 1_000_000).then(
        () => undefined,
        (cause: Error) => cause
      );
      expect(error?.message).toMatch(REFUSAL);
      expect(error?.message).not.toContain('{{');
    });
  }

  it('keeps an ordinary refresh', async () => {
    tokenEndpoint({ access_token: 'new', refresh_token: 'rotated' });
    const out = await refreshOAuth2Auth(expiring, 1_000_000);
    expect(out.oauth2?.accessToken).toBe('new');
  });
});

describe('a stored OAuth 2.0 token at send', () => {
  const credential = (tokenType: string, accessToken: string) =>
    buildAuthCredential({ type: 'oauth2', oauth2: { accessToken, tokenType } });

  it('refuses a variable token formed by the token type and access token', () => {
    expect(() => credential('{{sec', '}}')).toThrow(REFUSAL);
  });

  it('refuses it without showing either value', () => {
    expect(() => credential('{{sec', 'x}}')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('{{') })
    );
  });

  it('keeps tokens written in one field and ordinary values', () => {
    expect(credential('Bearer', '{{sec}}').headers['Authorization']).toBe('Bearer {{sec}}');
    expect(credential('{{type}}', 'abc').headers['Authorization']).toBe('{{type}} abc');
    expect(credential('Bearer', 'abc').headers['Authorization']).toBe('Bearer abc');
  });
});

describe('a stored OAuth 2.0 token pair on the send path', () => {
  it('fails before anything is sent', async () => {
    proxied.mockReset();
    await expect(
      executeRequest({
        request: {
          id: 'r',
          name: 'r',
          type: 'http',
          method: 'GET',
          url: 'https://a.test/',
          headers: [],
          params: [],
          body: { type: 'none' },
          auth: { type: 'oauth2', oauth2: { accessToken: '}}', tokenType: '{{sec' } },
        },
        envVars: {},
        secretVariables: { sec: { kind: 'handle', id: 'h' } },
        globalSettings: useSettingsStore.getState().settings,
        resolveVariables: (text) => text,
      })
    ).rejects.toThrow(/form a variable reference/);
    expect(proxied).not.toHaveBeenCalled();
  });
});

describe('the shared token client', () => {
  it('reports the refusal through the OAuth error type', async () => {
    tokenEndpoint({ access_token: '{{sec}}' });
    await expect(
      fetchClientCredentialsToken({
        grantType: 'client_credentials',
        clientId: 'c',
        tokenUrl: 'https://a.test/token',
      })
    ).rejects.toMatchObject({ name: 'OAuth2TokenError', errorCode: 'invalid_token_value' });
  });
});
