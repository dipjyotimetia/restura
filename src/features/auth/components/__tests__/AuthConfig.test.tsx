import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthConfig as AuthConfigType } from '@/types';

// Mock the platform helper so we can flip between Electron and web modes.
vi.mock('@/lib/shared/platform', () => ({
  isElectron: vi.fn(() => false),
}));

// Mock the OAuth2 helpers — they make network calls we don't want in unit tests.
vi.mock('@/features/auth/lib/oauth2', () => ({
  fetchClientCredentialsToken: vi.fn(),
  fetchPasswordToken: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  authorizeWithPopup: vi.fn(),
  fetchDeviceCode: vi.fn(),
  pollForDeviceToken: vi.fn(),
}));

import AuthConfiguration from '../AuthConfig';
import * as platform from '@/lib/shared/platform';

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
      expect(screen.getByText(/Include body params in signature/i)).toBeInTheDocument();
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

  describe('NTLM', () => {
    it('renders the "Desktop only" badge always', () => {
      const ntlmAuth: AuthConfigType = {
        type: 'ntlm',
        ntlm: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={ntlmAuth} onChange={vi.fn()} />);
      expect(screen.getByTestId('ntlm-platform-badge')).toHaveTextContent('Desktop only');
    });

    it('shows the web-runtime warning when isElectron() is false', () => {
      vi.mocked(platform.isElectron).mockReturnValue(false);
      const ntlmAuth: AuthConfigType = {
        type: 'ntlm',
        ntlm: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={ntlmAuth} onChange={vi.fn()} />);
      expect(screen.getByTestId('ntlm-web-warning')).toHaveTextContent(/Will not run in browser/i);
    });

    it('hides the web-runtime warning when isElectron() is true', () => {
      vi.mocked(platform.isElectron).mockReturnValue(true);
      const ntlmAuth: AuthConfigType = {
        type: 'ntlm',
        ntlm: { username: '', password: '' },
      };
      render(<AuthConfiguration auth={ntlmAuth} onChange={vi.fn()} />);
      expect(screen.queryByTestId('ntlm-web-warning')).not.toBeInTheDocument();
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
});
