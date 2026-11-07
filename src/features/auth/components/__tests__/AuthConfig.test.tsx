import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig as AuthConfigType } from '@/types';

// Mock the platform helper so we can flip between Electron and web modes.
vi.mock('@/lib/shared/platform', () => ({
  isElectron: vi.fn(() => false),
}));

// Mock the OAuth2 helpers — they make network calls we don't want in unit tests.
const executeProxiedRequestMock = vi.hoisted(() =>
  vi.fn(async () => ({ status: 200, statusText: 'OK', headers: {}, data: {} }))
);
vi.mock('@/lib/shared/transport', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeProxiedRequest: executeProxiedRequestMock,
}));

vi.mock('@/features/auth/lib/oauth2', () => ({
  fetchClientCredentialsToken: vi.fn(),
  fetchPasswordToken: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  authorizeWithPopup: vi.fn(),
  fetchDeviceCode: vi.fn(),
  pollForDeviceToken: vi.fn(),
  tokenExpiresAt: (nowMs: number, expiresInSeconds?: number) =>
    expiresInSeconds ? nowMs + expiresInSeconds * 1000 : undefined,
}));

import * as oauth2 from '@/features/auth/lib/oauth2';
import * as platform from '@/lib/shared/platform';
import { useRequestStore } from '@/store/useRequestStore';
import AuthConfiguration from '../AuthConfig';

const noneAuth: AuthConfigType = { type: 'none' };

describe('AuthConfiguration — new auth variants', () => {
  beforeEach(() => {
    vi.mocked(platform.isElectron).mockReturnValue(false);
  });

  describe('OAuth 1.0', () => {
    it('reveals OAuth 1.0 fields when type is oauth1', () => {
      const oauth1Auth: AuthConfigType = {
        type: 'oauth1',
        oauth1: { consumerKey: '', consumerSecret: '' },
      };
      render(<AuthConfiguration auth={oauth1Auth} onChange={vi.fn()} />);
      expect(screen.getByText('Consumer Key')).toBeInTheDocument();
      expect(screen.getByText('Consumer Secret')).toBeInTheDocument();
      expect(screen.getByText('Signature Method')).toBeInTheDocument();
      expect(
        screen.getByText(/Form body fields .* are always included in the/i)
      ).toBeInTheDocument();
    });

    it('persists consumer key edits via onChange with shape {type, oauth1}', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      const oauth1Auth: AuthConfigType = {
        type: 'oauth1',
        oauth1: { consumerKey: '', consumerSecret: '' },
      };
      render(<AuthConfiguration auth={oauth1Auth} onChange={onChange} />);
      const consumerKey = screen.getByPlaceholderText('Enter consumer key');
      await user.type(consumerKey, 'k');
      expect(onChange).toHaveBeenCalled();
      const lastCall = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(lastCall.type).toBe('oauth1');
      expect(lastCall.oauth1?.consumerKey).toBe('k');
    });
  });

  describe('Digest', () => {
    it('no longer warns that Digest auth is unapplied (it is answered at the wire)', () => {
      const digestAuth: AuthConfigType = {
        type: 'digest',
        digest: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={digestAuth} onChange={vi.fn()} />);
      expect(screen.queryByTestId('digest-unimplemented-warning')).toBeNull();
      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    });
  });

  describe('NTLM', () => {
    it('warns on web that NTLM is desktop-only and is not applied here', () => {
      const ntlmAuth: AuthConfigType = {
        type: 'ntlm',
        ntlm: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={ntlmAuth} onChange={vi.fn()} />);
      expect(screen.getByTestId('ntlm-unimplemented-warning')).toHaveTextContent(
        /desktop-only.*without authentication/i
      );
    });

    it('shows no unapplied warning on desktop, where the handshake runs (#1069)', () => {
      vi.mocked(platform.isElectron).mockReturnValue(true);
      const ntlmAuth: AuthConfigType = {
        type: 'ntlm',
        ntlm: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={ntlmAuth} onChange={vi.fn()} />);
      expect(screen.queryByTestId('ntlm-unimplemented-warning')).toBeNull();
      expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    });

    it('persists username edits via onChange with shape {type, ntlm}', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      const ntlmAuth: AuthConfigType = {
        type: 'ntlm',
        ntlm: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={ntlmAuth} onChange={onChange} />);
      const username = screen.getByPlaceholderText('Enter username');
      await user.type(username, 'a');
      const lastCall = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(lastCall.type).toBe('ntlm');
      expect(lastCall.ntlm?.username).toBe('a');
    });
  });

  describe('WSSE', () => {
    it('reveals WSSE fields when type is wsse', () => {
      const wsseAuth: AuthConfigType = {
        type: 'wsse',
        wsse: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={wsseAuth} onChange={vi.fn()} />);
      expect(screen.getByText('Password Type')).toBeInTheDocument();
    });

    it('shows clear-password warning when passwordType is PasswordText', () => {
      const wsseAuth: AuthConfigType = {
        type: 'wsse',
        wsse: { username: '', password: '', passwordType: 'PasswordText' },
      };
      render(<AuthConfiguration auth={wsseAuth} onChange={vi.fn()} />);
      expect(screen.getByTestId('wsse-password-text-warning')).toHaveTextContent(
        /sends the password in the clear/i
      );
    });

    it('does not show the warning when passwordType is PasswordDigest', () => {
      const wsseAuth: AuthConfigType = {
        type: 'wsse',
        wsse: { username: '', password: '', passwordType: 'PasswordDigest' },
      };
      render(<AuthConfiguration auth={wsseAuth} onChange={vi.fn()} />);
      expect(screen.queryByTestId('wsse-password-text-warning')).not.toBeInTheDocument();
    });

    it('persists username edits via onChange with shape {type, wsse}', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      const wsseAuth: AuthConfigType = {
        type: 'wsse',
        wsse: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={wsseAuth} onChange={onChange} />);
      const username = screen.getByPlaceholderText('Enter username');
      await user.type(username, 'u');
      const lastCall = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(lastCall.type).toBe('wsse');
      expect(lastCall.wsse?.username).toBe('u');
    });
  });

  describe('Empty state', () => {
    it('shows the no-authentication empty state when type is none', () => {
      render(<AuthConfiguration auth={noneAuth} onChange={vi.fn()} />);
      expect(screen.getByText('No authentication')).toBeInTheDocument();
    });
  });

  describe('OAuth 2.0 Get Token secrets and transport', () => {
    const withSecret = (clientSecret: unknown): AuthConfigType =>
      ({
        type: 'oauth2',
        oauth2: {
          grantType: 'client_credentials',
          clientId: 'client-id',
          clientSecret,
          tokenUrl: 'https://auth.example.com/token',
          accessToken: '',
        },
      }) as AuthConfigType;

    it.each([
      ['a keychain handle', { kind: 'handle', id: 'h-1' }],
      [
        'an external-vault reference',
        { kind: 'external', provider: 'aws-secrets-manager', profileId: 'p', secretId: 's' },
      ],
    ])('refuses to send a client secret stored as %s and says why', async (_label, secret) => {
      const user = userEvent.setup();
      vi.mocked(oauth2.fetchClientCredentialsToken).mockClear();
      render(<AuthConfiguration auth={withSecret(secret)} onChange={vi.fn()} />);

      await user.click(screen.getByRole('button', { name: 'Get New Access Token' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/client secret.*can't be read/i);
      expect(oauth2.fetchClientCredentialsToken).not.toHaveBeenCalled();
    });

    it('sends the token request through the app HTTP transport', async () => {
      const user = userEvent.setup();
      vi.mocked(oauth2.fetchClientCredentialsToken).mockClear();
      vi.mocked(oauth2.fetchClientCredentialsToken).mockResolvedValueOnce({ access_token: 'at' });
      const onChange = vi.fn();
      render(<AuthConfiguration auth={withSecret('inline-secret')} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Get New Access Token' }));

      await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(oauth2.fetchClientCredentialsToken).toHaveBeenCalledWith(
        expect.objectContaining({ clientSecret: 'inline-secret' }),
        { fetch: expect.any(Function), signal: expect.any(AbortSignal) }
      );
      const [, transport] = vi.mocked(oauth2.fetchClientCredentialsToken).mock.calls[0] ?? [];
      expect(transport?.fetch).not.toBe(globalThis.fetch);
    });

    it("sends the token request with the open request's TLS settings", async () => {
      const user = userEvent.setup();
      vi.mocked(platform.isElectron).mockReturnValue(true);
      vi.mocked(oauth2.fetchClientCredentialsToken).mockClear();
      vi.mocked(oauth2.fetchClientCredentialsToken).mockResolvedValueOnce({ access_token: 'at' });
      useRequestStore.setState({
        tabs: [
          {
            id: 't1',
            request: {
              id: 'r1',
              name: 'r',
              type: 'http',
              method: 'GET',
              url: 'https://api.internal/x',
              headers: [],
              params: [],
              body: { type: 'none' },
              auth: { type: 'none' },
              settings: { verifySsl: false },
            },
          },
        ],
        activeTabId: 't1',
      } as never);
      const onChange = vi.fn();
      render(<AuthConfiguration auth={withSecret('inline-secret')} onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: 'Get New Access Token' }));
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

      const [, transport] = vi.mocked(oauth2.fetchClientCredentialsToken).mock.calls[0] ?? [];
      executeProxiedRequestMock.mockClear();
      await transport?.fetch?.('https://idp.internal/token', { method: 'POST', body: 'a=1' });
      expect(executeProxiedRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://idp.internal/token' }),
        {},
        expect.objectContaining({ verifySsl: false })
      );
    });
  });

  describe('OAuth 2.0 editor lifecycle', () => {
    it('keeps token acquisition feedback while another scheme is temporarily selected', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      const oauth2Auth: AuthConfigType = {
        type: 'oauth2',
        oauth2: {
          grantType: 'client_credentials',
          clientId: 'client-id',
          clientSecret: '',
          tokenUrl: 'https://auth.example.com/token',
          accessToken: '',
        },
      };
      vi.mocked(oauth2.fetchClientCredentialsToken).mockRejectedValueOnce(
        new Error('Token endpoint unavailable')
      );
      const { rerender } = render(<AuthConfiguration auth={oauth2Auth} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Get New Access Token' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Token endpoint unavailable');

      rerender(<AuthConfiguration auth={{ type: 'none' }} onChange={onChange} />);
      rerender(<AuthConfiguration auth={oauth2Auth} onChange={onChange} />);

      expect(screen.getByRole('alert')).toHaveTextContent('Token endpoint unavailable');
    });

    const clientCredentials = (extra: Record<string, unknown> = {}): AuthConfigType => ({
      type: 'oauth2',
      oauth2: {
        grantType: 'client_credentials',
        clientId: 'client-id',
        tokenUrl: 'https://auth.example.com/token',
        accessToken: '',
        ...extra,
      },
    });

    it('stores the issued refresh token and expiry so auto-refresh can run', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      vi.mocked(oauth2.fetchClientCredentialsToken).mockResolvedValueOnce({
        access_token: 'at-1',
        token_type: 'Bearer',
        refresh_token: 'rt-1',
        expires_in: 3600,
      });
      render(<AuthConfiguration auth={clientCredentials()} onChange={onChange} />);

      try {
        await user.click(screen.getByRole('button', { name: 'Get New Access Token' }));
        await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
      } finally {
        nowSpy.mockRestore();
      }
      const next = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(next.oauth2?.accessToken).toEqual({ kind: 'inline', value: 'at-1' });
      expect(next.oauth2?.refreshToken).toEqual({ kind: 'inline', value: 'rt-1' });
      expect(next.oauth2?.expiresAt).toBe(1_000_000 + 3_600_000);
    });

    it('clears a stale refresh token and expiry when the new token has none', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      vi.mocked(oauth2.fetchClientCredentialsToken).mockResolvedValueOnce({
        access_token: 'at-2',
      });
      render(
        <AuthConfiguration
          auth={clientCredentials({ refreshToken: 'consumed', expiresAt: 5 })}
          onChange={onChange}
        />
      );

      await user.click(screen.getByRole('button', { name: 'Get New Access Token' }));

      await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
      const next = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(next.oauth2?.accessToken).toEqual({ kind: 'inline', value: 'at-2' });
      expect(next.oauth2).not.toHaveProperty('refreshToken');
      expect(next.oauth2).not.toHaveProperty('expiresAt');
    });

    it('reports the authorization-code popup flow as unavailable on desktop', async () => {
      vi.mocked(platform.isElectron).mockReturnValue(true);
      const user = userEvent.setup();
      const open = vi.spyOn(window, 'open');
      render(
        <AuthConfiguration
          auth={{
            type: 'oauth2',
            oauth2: {
              grantType: 'authorization_code',
              clientId: 'client-id',
              authorizationUrl: 'https://auth.example.com/authorize',
              tokenUrl: 'https://auth.example.com/token',
              accessToken: '',
            },
          }}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByTestId('oauth2-authcode-unavailable')).toBeInTheDocument();
      const button = screen.getByRole('button', { name: 'Get New Access Token' });
      expect(button).toBeDisabled();
      await user.click(button);
      expect(oauth2.buildAuthorizationUrl).not.toHaveBeenCalled();
      expect(oauth2.authorizeWithPopup).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      open.mockRestore();
    });
  });

  // Regression: basic/api-key/aws-signature must seed their full sub-object on
  // the first field edit. Without it, the partial object (e.g. basic with a
  // username but no password) fails the request schema and updateRequest()
  // rejects the whole edit, so the field can never be filled. Each field-type's
  // first keystroke must emit an object with every required key present.
  describe('seeds full sub-objects so partial entry stays schema-valid', () => {
    it('basic: preserves an existing SecretRef handle when the username changes', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      const password = { kind: 'handle' as const, id: 'basic-password', label: 'Basic password' };
      render(
        <AuthConfiguration
          auth={{ type: 'basic', basic: { username: '', password } }}
          onChange={onChange}
        />
      );

      await user.type(screen.getByPlaceholderText('Enter username'), 'a');

      const last = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(last.basic).toEqual({ username: 'a', password });
    });

    it('basic: typing a username emits both username and password', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<AuthConfiguration auth={{ type: 'basic' }} onChange={onChange} />);
      await user.type(screen.getByPlaceholderText('Enter username'), 'a');
      const last = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(last.basic).toEqual({ username: 'a', password: '' });
    });

    it('api-key: typing a key emits key, value and placement', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<AuthConfiguration auth={{ type: 'api-key' }} onChange={onChange} />);
      await user.type(screen.getByPlaceholderText('e.g., X-API-Key'), 'a');
      const last = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(last.apiKey).toEqual({ key: 'a', value: '', in: 'header' });
    });

    it('aws-signature: typing an access key emits all four fields', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<AuthConfiguration auth={{ type: 'aws-signature' }} onChange={onChange} />);
      await user.type(screen.getByPlaceholderText('Enter AWS access key'), 'a');
      const last = onChange.mock.calls.at(-1)?.[0] as AuthConfigType;
      expect(last.awsSignature).toEqual({
        accessKey: 'a',
        secretKey: '',
        region: '',
        service: '',
      });
    });
  });
});
