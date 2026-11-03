import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  authorizeWithPopup,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchClientCredentialsToken,
  fetchDeviceCode,
  fetchPasswordToken,
  type OAuth2TokenResponse,
  pollForDeviceToken,
  tokenExpiresAt,
} from '@/features/auth/lib/oauth2';
import { isCapableHere } from '@/lib/shared/capabilities';
import { isElectron } from '@/lib/shared/platform';
import { unwrapSecret } from '@/lib/shared/secretRef';
import type { AuthConfig } from '@/types';
import SecretInput from '../SecretInput';
import type { AuthEditorProps } from './types';
import { UnappliedAuthNotice } from './UnappliedAuthNotice';

// Desktop denies renderer popups, so the redirect can never be captured there.
const AUTH_CODE_DESKTOP_MESSAGE =
  'Authorization Code sign-in is not available in the desktop app yet. Use another grant type or paste an access token below.';

type OAuth2Settings = NonNullable<AuthConfig['oauth2']>;

/**
 * Apply a fresh token response. The refresh token and expiry always come from
 * this response: stale ones from an earlier token are dropped, so auto-refresh
 * never replays a consumed refresh token over a newer access token.
 */
function withIssuedToken(
  oauth: OAuth2Settings,
  response: OAuth2TokenResponse,
  nowMs: number
): OAuth2Settings {
  const { refreshToken: _staleRefresh, expiresAt: _staleExpiry, ...rest } = oauth;
  const expiresAt = tokenExpiresAt(nowMs, response.expires_in);
  return {
    ...rest,
    accessToken: { kind: 'inline', value: response.access_token },
    ...(response.token_type !== undefined && { tokenType: response.token_type }),
    ...(response.refresh_token !== undefined && {
      refreshToken: { kind: 'inline', value: response.refresh_token },
    }),
    ...(expiresAt !== undefined && { expiresAt }),
  };
}

export function OAuth2AuthEditor({ auth, onChange }: AuthEditorProps) {
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  const oauth2 = auth.oauth2;
  const grantType = oauth2?.grantType ?? 'authorization_code';
  const authCodeUnavailable =
    grantType === 'authorization_code' &&
    !isCapableHere('http.auth.oauth2AuthCodePopup', isElectron());

  if (auth.type !== 'oauth2') return null;

  const handleGetToken = async () => {
    if (!auth.oauth2) return;
    const oauth = auth.oauth2;
    if (!oauth.grantType || !oauth.tokenUrl || !oauth.clientId) {
      setTokenError('Client ID, Token URL, and Grant Type are required');
      return;
    }
    if (authCodeUnavailable) return;

    setTokenLoading(true);
    setTokenError(null);
    setDeviceCodeInfo(null);

    try {
      // Keep SecretRef values opaque in renderer-side token acquisition. A
      // handle is represented by its masked placeholder and fails upstream
      // rather than exposing a value that only Electron main may resolve.
      const config = {
        grantType: oauth.grantType,
        clientId: oauth.clientId,
        tokenUrl: oauth.tokenUrl,
        ...(oauth.clientSecret !== undefined && { clientSecret: unwrapSecret(oauth.clientSecret) }),
        ...(oauth.authorizationUrl !== undefined && { authorizationUrl: oauth.authorizationUrl }),
        ...(oauth.deviceAuthorizationUrl !== undefined && {
          deviceAuthorizationUrl: oauth.deviceAuthorizationUrl,
        }),
        ...(oauth.redirectUri !== undefined && { redirectUri: oauth.redirectUri }),
        ...(oauth.scope !== undefined && { scope: oauth.scope }),
        ...(oauth.username !== undefined && { username: oauth.username }),
        ...(oauth.password !== undefined && { password: unwrapSecret(oauth.password) }),
      };

      let response: OAuth2TokenResponse;

      if (oauth.grantType === 'client_credentials') {
        response = await fetchClientCredentialsToken(config);
      } else if (oauth.grantType === 'password') {
        response = await fetchPasswordToken(config);
      } else if (oauth.grantType === 'authorization_code') {
        const { url, codeVerifier, state } = await buildAuthorizationUrl(config);
        const result = await authorizeWithPopup(url, state);
        if (!result) {
          setTokenError('Authorization was cancelled or the popup was blocked');
          return;
        }
        response = await exchangeCodeForToken(config, result.code, codeVerifier);
      } else if (oauth.grantType === 'device_code') {
        const device = await fetchDeviceCode(config);
        setDeviceCodeInfo({ userCode: device.user_code, verificationUri: device.verification_uri });
        response = await pollForDeviceToken(
          config,
          device.device_code,
          device.interval ?? 5,
          Math.ceil(device.expires_in / (device.interval ?? 5))
        );
        setDeviceCodeInfo(null);
      } else {
        setTokenError('Unsupported grant type');
        return;
      }

      onChange({ ...auth, oauth2: withIssuedToken(oauth, response, Date.now()) });
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : 'Failed to get token');
    } finally {
      setTokenLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="auth-oauth2-grant-type" className="text-sm font-medium mb-2 block">
          Grant Type
        </label>
        <Select
          value={grantType}
          onValueChange={(value) =>
            onChange({ ...auth, oauth2: { ...oauth2!, grantType: value as typeof grantType } })
          }
        >
          <SelectTrigger id="auth-oauth2-grant-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="authorization_code">Authorization Code (PKCE)</SelectItem>
            <SelectItem value="client_credentials">Client Credentials</SelectItem>
            <SelectItem value="password">Password</SelectItem>
            <SelectItem value="device_code">Device Code</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label htmlFor="auth-oauth2-client-id" className="text-sm font-medium mb-2 block">
          Client ID
        </label>
        <Input
          id="auth-oauth2-client-id"
          value={oauth2?.clientId ?? ''}
          onChange={(event) =>
            onChange({ ...auth, oauth2: { ...oauth2!, clientId: event.target.value } })
          }
          placeholder="Enter client ID"
        />
      </div>
      <div>
        <label htmlFor="auth-oauth2-client-secret" className="text-sm font-medium mb-2 block">
          Client Secret
        </label>
        <SecretInput
          id="auth-oauth2-client-secret"
          value={oauth2?.clientSecret}
          onChange={(clientSecret) => onChange({ ...auth, oauth2: { ...oauth2!, clientSecret } })}
          placeholder="Enter client secret (optional for PKCE)"
          storageLabel="oauth2.clientSecret"
        />
      </div>
      {grantType === 'authorization_code' && (
        <div>
          <label htmlFor="auth-oauth2-authorization-url" className="text-sm font-medium mb-2 block">
            Authorization URL
          </label>
          <Input
            id="auth-oauth2-authorization-url"
            value={oauth2?.authorizationUrl ?? ''}
            onChange={(event) =>
              onChange({ ...auth, oauth2: { ...oauth2!, authorizationUrl: event.target.value } })
            }
            placeholder="https://auth.example.com/authorize"
            className="font-mono"
          />
        </div>
      )}
      {grantType === 'device_code' && (
        <div>
          <label
            htmlFor="auth-oauth2-device-authorization-url"
            className="text-sm font-medium mb-2 block"
          >
            Device Authorization URL
          </label>
          <Input
            id="auth-oauth2-device-authorization-url"
            value={oauth2?.deviceAuthorizationUrl ?? ''}
            onChange={(event) =>
              onChange({
                ...auth,
                oauth2: { ...oauth2!, deviceAuthorizationUrl: event.target.value },
              })
            }
            placeholder="https://auth.example.com/device_authorization"
            className="font-mono"
          />
        </div>
      )}
      <div>
        <label htmlFor="auth-oauth2-token-url" className="text-sm font-medium mb-2 block">
          Token URL
        </label>
        <Input
          id="auth-oauth2-token-url"
          value={oauth2?.tokenUrl ?? ''}
          onChange={(event) =>
            onChange({ ...auth, oauth2: { ...oauth2!, tokenUrl: event.target.value } })
          }
          placeholder="https://auth.example.com/token"
          className="font-mono"
        />
      </div>
      {grantType === 'authorization_code' && (
        <div>
          <label htmlFor="auth-oauth2-redirect-uri" className="text-sm font-medium mb-2 block">
            Redirect URI
          </label>
          <Input
            id="auth-oauth2-redirect-uri"
            value={oauth2?.redirectUri ?? ''}
            onChange={(event) =>
              onChange({ ...auth, oauth2: { ...oauth2!, redirectUri: event.target.value } })
            }
            placeholder="https://your-app.com/callback"
            className="font-mono"
          />
        </div>
      )}
      <div>
        <label htmlFor="auth-oauth2-scope" className="text-sm font-medium mb-2 block">
          Scope (optional)
        </label>
        <Input
          id="auth-oauth2-scope"
          value={oauth2?.scope ?? ''}
          onChange={(event) =>
            onChange({ ...auth, oauth2: { ...oauth2!, scope: event.target.value } })
          }
          placeholder="openid email profile"
        />
      </div>
      {grantType === 'password' && (
        <>
          <div>
            <label htmlFor="auth-oauth2-username" className="text-sm font-medium mb-2 block">
              Username
            </label>
            <Input
              id="auth-oauth2-username"
              value={oauth2?.username ?? ''}
              onChange={(event) =>
                onChange({ ...auth, oauth2: { ...oauth2!, username: event.target.value } })
              }
              placeholder="Username"
            />
          </div>
          <div>
            <label htmlFor="auth-oauth2-password" className="text-sm font-medium mb-2 block">
              Password
            </label>
            <SecretInput
              id="auth-oauth2-password"
              value={oauth2?.password}
              onChange={(password) => onChange({ ...auth, oauth2: { ...oauth2!, password } })}
              placeholder="Password"
              storageLabel="oauth2.password"
            />
          </div>
        </>
      )}
      {authCodeUnavailable && (
        <UnappliedAuthNotice
          message={AUTH_CODE_DESKTOP_MESSAGE}
          testId="oauth2-authcode-unavailable"
        />
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={handleGetToken}
        disabled={tokenLoading || authCodeUnavailable}
        className="w-full"
      >
        {tokenLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        {tokenLoading ? 'Getting Token...' : 'Get New Access Token'}
      </Button>
      {deviceCodeInfo && (
        <div className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs space-y-1">
          <p className="font-medium">Device Authorization Required</p>
          <p>
            Go to <span className="font-mono text-primary">{deviceCodeInfo.verificationUri}</span>
          </p>
          <p>
            Enter code:{' '}
            <span className="font-mono font-bold text-primary">{deviceCodeInfo.userCode}</span>
          </p>
          <p className="text-muted-foreground">Waiting for authorization...</p>
        </div>
      )}
      {tokenError && (
        <p role="alert" className="text-xs text-red-500">
          {tokenError}
        </p>
      )}
      <div className="border-t border-border pt-4">
        <label htmlFor="auth-oauth2-access-token" className="text-sm font-medium mb-2 block">
          Access Token
        </label>
        <SecretInput
          id="auth-oauth2-access-token"
          value={oauth2?.accessToken}
          onChange={(accessToken) => onChange({ ...auth, oauth2: { ...oauth2!, accessToken } })}
          placeholder="Token will appear here after authorization"
          storageLabel="oauth2.accessToken"
        />
      </div>
      <div>
        <label htmlFor="auth-oauth2-token-type" className="text-sm font-medium mb-2 block">
          Token Type (optional)
        </label>
        <Input
          id="auth-oauth2-token-type"
          value={oauth2?.tokenType ?? ''}
          onChange={(event) =>
            onChange({ ...auth, oauth2: { ...oauth2!, tokenType: event.target.value } })
          }
          placeholder="Bearer"
        />
      </div>
    </div>
  );
}
