'use client';

import { AlertTriangle, Loader2, Lock } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  pollForDeviceToken,
} from '@/features/auth/lib/oauth2';
import { unwrapSecret } from '@/lib/shared/secretRef';
import type { AuthConfig } from '@/types';
import SecretInput from './SecretInput';

interface AuthConfigProps {
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
}

/**
 * Digest and NTLM are selectable and persist their config, but no backend
 * currently applies them to the wire (buildAuthCredential / auth-applier /
 * auth-signer all no-op these types). Surface that explicitly so the request
 * isn't silently sent unauthenticated. Remove when the scheme is implemented.
 */
function UnappliedAuthNotice({ scheme }: { scheme: 'Digest' | 'NTLM' }) {
  return (
    <p
      className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500 flex items-center gap-2"
      data-testid={`${scheme.toLowerCase()}-unimplemented-warning`}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {scheme} authentication isn’t applied yet — the request is sent without authentication.
      Credentials below are saved but not used.
    </p>
  );
}

export default function AuthConfiguration({ auth, onChange }: AuthConfigProps) {
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);

  const handleGetToken = async () => {
    if (!auth.oauth2) return;
    const o = auth.oauth2;
    if (!o.grantType || !o.tokenUrl || !o.clientId) {
      setTokenError('Client ID, Token URL, and Grant Type are required');
      return;
    }

    setTokenLoading(true);
    setTokenError(null);
    setDeviceCodeInfo(null);

    try {
      // EOPT: build the config without undefined-valued keys so it matches the
      // OAuth2FlowConfig contract under exactOptionalPropertyTypes.
      // SecretRef-aware: clientSecret/password are SecretValue and are
      // unwrapped via `unwrapSecret` (returns the masked placeholder for
      // handle refs — token fetch from a handle-protected creds is best-effort
      // on the renderer; the upstream will reject with a clear error).
      const config = {
        grantType: o.grantType,
        clientId: o.clientId,
        tokenUrl: o.tokenUrl,
        ...(o.clientSecret !== undefined && { clientSecret: unwrapSecret(o.clientSecret) }),
        ...(o.authorizationUrl !== undefined && { authorizationUrl: o.authorizationUrl }),
        ...(o.deviceAuthorizationUrl !== undefined && {
          deviceAuthorizationUrl: o.deviceAuthorizationUrl,
        }),
        ...(o.redirectUri !== undefined && { redirectUri: o.redirectUri }),
        ...(o.scope !== undefined && { scope: o.scope }),
        ...(o.username !== undefined && { username: o.username }),
        ...(o.password !== undefined && { password: unwrapSecret(o.password) }),
      };

      let token: string;
      let tokenType: string | undefined;

      if (o.grantType === 'client_credentials') {
        const res = await fetchClientCredentialsToken(config);
        token = res.access_token;
        tokenType = res.token_type;
      } else if (o.grantType === 'password') {
        const res = await fetchPasswordToken(config);
        token = res.access_token;
        tokenType = res.token_type;
      } else if (o.grantType === 'authorization_code') {
        const { url, codeVerifier, state } = await buildAuthorizationUrl(config);
        const result = await authorizeWithPopup(url, state);
        if (!result) {
          setTokenError('Authorization was cancelled or the popup was blocked');
          return;
        }
        const res = await exchangeCodeForToken(config, result.code, codeVerifier);
        token = res.access_token;
        tokenType = res.token_type;
      } else if (o.grantType === 'device_code') {
        const device = await fetchDeviceCode(config);
        setDeviceCodeInfo({ userCode: device.user_code, verificationUri: device.verification_uri });
        const res = await pollForDeviceToken(
          config,
          device.device_code,
          device.interval ?? 5,
          Math.ceil(device.expires_in / (device.interval ?? 5))
        );
        token = res.access_token;
        tokenType = res.token_type;
        setDeviceCodeInfo(null);
      } else {
        setTokenError('Unsupported grant type');
        return;
      }

      onChange({
        ...auth,
        oauth2: {
          ...auth.oauth2!,
          accessToken: { kind: 'inline', value: token },
          ...(tokenType !== undefined && { tokenType }),
        },
      });
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to get token');
    } finally {
      setTokenLoading(false);
    }
  };

  const renderAuthFields = () => {
    switch (auth.type) {
      case 'basic': {
        // Seed both fields so a partial entry (e.g. username before password)
        // still produces a schema-valid `basic` object — validateRequestUpdate
        // rejects the whole update otherwise. Mirrors the ntlm/wsse handlers.
        const b = auth.basic ?? { username: '', password: '' };
        return (
          <div className="space-y-4">
            <div>
              <label htmlFor="auth-basic-username" className="text-sm font-medium mb-2 block">
                Username
              </label>
              <Input
                id="auth-basic-username"
                value={auth.basic?.username || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    basic: { ...b, username: e.target.value },
                  })
                }
                placeholder="Enter username"
                className="bg-background border-border"
              />
            </div>
            <div>
              <label htmlFor="auth-basic-password" className="text-sm font-medium mb-2 block">
                Password
              </label>
              <SecretInput
                id="auth-basic-password"
                value={auth.basic?.password}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    basic: { ...b, password: next },
                  })
                }
                placeholder="Enter password"
                storageLabel="basic.password"
              />
            </div>
          </div>
        );
      }

      case 'bearer':
        return (
          <div className="space-y-4">
            <div>
              <label htmlFor="auth-bearer-token" className="text-sm font-medium mb-2 block">
                Token
              </label>
              <SecretInput
                id="auth-bearer-token"
                value={auth.bearer?.token}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    bearer: { token: next },
                  })
                }
                placeholder="Enter bearer token"
                storageLabel="bearer.token"
              />
            </div>
          </div>
        );

      case 'api-key': {
        const k = auth.apiKey ?? { key: '', value: '', in: 'header' as const };
        return (
          <div className="space-y-4">
            <div>
              <label htmlFor="auth-apikey-key" className="text-sm font-medium mb-2 block">
                Key
              </label>
              <Input
                id="auth-apikey-key"
                value={auth.apiKey?.key || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    apiKey: { ...k, key: e.target.value },
                  })
                }
                placeholder="e.g., X-API-Key"
              />
            </div>
            <div>
              <label htmlFor="auth-apikey-value" className="text-sm font-medium mb-2 block">
                Value
              </label>
              <SecretInput
                id="auth-apikey-value"
                value={auth.apiKey?.value}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    apiKey: { ...k, value: next },
                  })
                }
                placeholder="Enter API key value"
                storageLabel="apiKey.value"
              />
            </div>
            <div>
              <label htmlFor="auth-apikey-in" className="text-sm font-medium mb-2 block">
                Add to
              </label>
              <Select
                value={auth.apiKey?.in || 'header'}
                onValueChange={(value: 'header' | 'query') =>
                  onChange({
                    ...auth,
                    apiKey: { ...k, in: value },
                  })
                }
              >
                <SelectTrigger id="auth-apikey-in">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="header">Header</SelectItem>
                  <SelectItem value="query">Query Params</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        );
      }

      case 'oauth2': {
        const o = auth.oauth2;
        const grantType = o?.grantType ?? 'authorization_code';
        return (
          <div className="space-y-4">
            <div>
              <label htmlFor="auth-oauth2-grant-type" className="text-sm font-medium mb-2 block">
                Grant Type
              </label>
              <Select
                value={grantType}
                onValueChange={(v) =>
                  onChange({ ...auth, oauth2: { ...o!, grantType: v as typeof grantType } })
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
                value={o?.clientId ?? ''}
                onChange={(e) => onChange({ ...auth, oauth2: { ...o!, clientId: e.target.value } })}
                placeholder="Enter client ID"
              />
            </div>
            <div>
              <label htmlFor="auth-oauth2-client-secret" className="text-sm font-medium mb-2 block">
                Client Secret
              </label>
              <SecretInput
                id="auth-oauth2-client-secret"
                value={o?.clientSecret}
                onChange={(next) => onChange({ ...auth, oauth2: { ...o!, clientSecret: next } })}
                placeholder="Enter client secret (optional for PKCE)"
                storageLabel="oauth2.clientSecret"
              />
            </div>
            {grantType === 'authorization_code' && (
              <div>
                <label
                  htmlFor="auth-oauth2-authorization-url"
                  className="text-sm font-medium mb-2 block"
                >
                  Authorization URL
                </label>
                <Input
                  id="auth-oauth2-authorization-url"
                  value={o?.authorizationUrl ?? ''}
                  onChange={(e) =>
                    onChange({ ...auth, oauth2: { ...o!, authorizationUrl: e.target.value } })
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
                  value={o?.deviceAuthorizationUrl ?? ''}
                  onChange={(e) =>
                    onChange({ ...auth, oauth2: { ...o!, deviceAuthorizationUrl: e.target.value } })
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
                value={o?.tokenUrl ?? ''}
                onChange={(e) => onChange({ ...auth, oauth2: { ...o!, tokenUrl: e.target.value } })}
                placeholder="https://auth.example.com/token"
                className="font-mono"
              />
            </div>
            {grantType === 'authorization_code' && (
              <div>
                <label
                  htmlFor="auth-oauth2-redirect-uri"
                  className="text-sm font-medium mb-2 block"
                >
                  Redirect URI
                </label>
                <Input
                  id="auth-oauth2-redirect-uri"
                  value={o?.redirectUri ?? ''}
                  onChange={(e) =>
                    onChange({ ...auth, oauth2: { ...o!, redirectUri: e.target.value } })
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
                value={o?.scope ?? ''}
                onChange={(e) => onChange({ ...auth, oauth2: { ...o!, scope: e.target.value } })}
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
                    value={o?.username ?? ''}
                    onChange={(e) =>
                      onChange({ ...auth, oauth2: { ...o!, username: e.target.value } })
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
                    value={o?.password}
                    onChange={(next) => onChange({ ...auth, oauth2: { ...o!, password: next } })}
                    placeholder="Password"
                    storageLabel="oauth2.password"
                  />
                </div>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleGetToken}
              disabled={tokenLoading}
              className="w-full"
            >
              {tokenLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {tokenLoading ? 'Getting Token...' : 'Get New Access Token'}
            </Button>
            {deviceCodeInfo && (
              <div className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs space-y-1">
                <p className="font-medium">Device Authorization Required</p>
                <p>
                  Go to{' '}
                  <span className="font-mono text-primary">{deviceCodeInfo.verificationUri}</span>
                </p>
                <p>
                  Enter code:{' '}
                  <span className="font-mono font-bold text-primary">
                    {deviceCodeInfo.userCode}
                  </span>
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
                value={o?.accessToken}
                onChange={(next) => onChange({ ...auth, oauth2: { ...o!, accessToken: next } })}
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
                value={o?.tokenType ?? ''}
                onChange={(e) =>
                  onChange({ ...auth, oauth2: { ...o!, tokenType: e.target.value } })
                }
                placeholder="Bearer"
              />
            </div>
          </div>
        );
      }

      case 'digest':
        return (
          <div className="space-y-4">
            <UnappliedAuthNotice scheme="Digest" />
            <div>
              <label htmlFor="auth-digest-username" className="text-sm font-medium mb-2 block">
                Username
              </label>
              <Input
                id="auth-digest-username"
                value={auth.digest?.username || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    digest: { ...auth.digest!, username: e.target.value },
                  })
                }
                placeholder="Enter username"
              />
            </div>
            <div>
              <label htmlFor="auth-digest-password" className="text-sm font-medium mb-2 block">
                Password
              </label>
              <SecretInput
                id="auth-digest-password"
                value={auth.digest?.password}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    digest: { ...auth.digest!, password: next },
                  })
                }
                placeholder="Enter password"
                storageLabel="digest.password"
              />
            </div>
          </div>
        );

      case 'aws-signature': {
        const a = auth.awsSignature ?? { accessKey: '', secretKey: '', region: '', service: '' };
        return (
          <div className="space-y-4">
            <div>
              <label htmlFor="auth-aws-access-key" className="text-sm font-medium mb-2 block">
                Access Key
              </label>
              <Input
                id="auth-aws-access-key"
                value={auth.awsSignature?.accessKey || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...a, accessKey: e.target.value },
                  })
                }
                placeholder="Enter AWS access key"
              />
            </div>
            <div>
              <label htmlFor="auth-aws-secret-key" className="text-sm font-medium mb-2 block">
                Secret Key
              </label>
              <SecretInput
                id="auth-aws-secret-key"
                value={auth.awsSignature?.secretKey}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...a, secretKey: next },
                  })
                }
                placeholder="Enter AWS secret key"
                storageLabel="awsSignature.secretKey"
              />
            </div>
            <div>
              <label htmlFor="auth-aws-region" className="text-sm font-medium mb-2 block">
                Region
              </label>
              <Input
                id="auth-aws-region"
                value={auth.awsSignature?.region || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...a, region: e.target.value },
                  })
                }
                placeholder="e.g., us-east-1"
              />
            </div>
            <div>
              <label htmlFor="auth-aws-service" className="text-sm font-medium mb-2 block">
                Service
              </label>
              <Input
                id="auth-aws-service"
                value={auth.awsSignature?.service || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...a, service: e.target.value },
                  })
                }
                placeholder="e.g., execute-api"
              />
            </div>
          </div>
        );
      }

      case 'oauth1': {
        const o = auth.oauth1;
        const signatureMethod = o?.signatureMethod ?? 'HMAC-SHA1';
        return (
          <div className="space-y-4">
            <div>
              <label htmlFor="auth-oauth1-consumer-key" className="text-sm font-medium mb-2 block">
                Consumer Key
              </label>
              <Input
                id="auth-oauth1-consumer-key"
                value={o?.consumerKey ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth1: {
                      ...(o ?? { consumerKey: '', consumerSecret: '' }),
                      consumerKey: e.target.value,
                    },
                  })
                }
                placeholder="Enter consumer key"
                className="font-mono bg-background border-border"
              />
            </div>
            <div>
              <label
                htmlFor="auth-oauth1-consumer-secret"
                className="text-sm font-medium mb-2 block"
              >
                Consumer Secret
              </label>
              <SecretInput
                id="auth-oauth1-consumer-secret"
                value={o?.consumerSecret}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    oauth1: {
                      ...(o ?? { consumerKey: '', consumerSecret: '' }),
                      consumerSecret: next,
                    },
                  })
                }
                placeholder="Enter consumer secret"
                storageLabel="oauth1.consumerSecret"
              />
            </div>
            <div>
              <label htmlFor="auth-oauth1-access-token" className="text-sm font-medium mb-2 block">
                Access Token (optional)
              </label>
              <SecretInput
                id="auth-oauth1-access-token"
                value={o?.accessToken}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    oauth1: {
                      ...(o ?? { consumerKey: '', consumerSecret: '' }),
                      accessToken: next,
                    },
                  })
                }
                placeholder="Enter access token"
                storageLabel="oauth1.accessToken"
              />
            </div>
            <div>
              <label
                htmlFor="auth-oauth1-access-token-secret"
                className="text-sm font-medium mb-2 block"
              >
                Access Token Secret (optional)
              </label>
              <SecretInput
                id="auth-oauth1-access-token-secret"
                value={o?.accessTokenSecret}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    oauth1: {
                      ...(o ?? { consumerKey: '', consumerSecret: '' }),
                      accessTokenSecret: next,
                    },
                  })
                }
                placeholder="Enter access token secret"
                storageLabel="oauth1.accessTokenSecret"
              />
            </div>
            <div>
              <label
                htmlFor="auth-oauth1-signature-method"
                className="text-sm font-medium mb-2 block"
              >
                Signature Method
              </label>
              <Select
                value={signatureMethod}
                onValueChange={(v) =>
                  onChange({
                    ...auth,
                    oauth1: {
                      ...(o ?? { consumerKey: '', consumerSecret: '' }),
                      signatureMethod: v as 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT',
                    },
                  })
                }
              >
                <SelectTrigger
                  id="auth-oauth1-signature-method"
                  className="bg-background border-border"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="HMAC-SHA1">HMAC-SHA1</SelectItem>
                  <SelectItem value="HMAC-SHA256">HMAC-SHA256</SelectItem>
                  <SelectItem value="PLAINTEXT">PLAINTEXT</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="auth-oauth1-realm" className="text-sm font-medium mb-2 block">
                Realm (optional)
              </label>
              <Input
                id="auth-oauth1-realm"
                value={o?.realm ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth1: {
                      ...(o ?? { consumerKey: '', consumerSecret: '' }),
                      realm: e.target.value,
                    },
                  })
                }
                placeholder="Enter realm"
                className="bg-background border-border"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="oauth1-add-params-to-body"
                checked={o?.addParamsToBody ?? false}
                onCheckedChange={(checked) =>
                  onChange({
                    ...auth,
                    oauth1: {
                      ...(o ?? { consumerKey: '', consumerSecret: '' }),
                      addParamsToBody: checked === true,
                    },
                  })
                }
              />
              <label
                htmlFor="oauth1-add-params-to-body"
                className="text-sm font-medium cursor-pointer"
              >
                Include body params in signature (RFC 5849 §3.4.1.3.1)
              </label>
            </div>
          </div>
        );
      }

      case 'ntlm': {
        const n = auth.ntlm;
        return (
          <div className="space-y-4">
            <UnappliedAuthNotice scheme="NTLM" />
            <div>
              <label htmlFor="auth-ntlm-username" className="text-sm font-medium mb-2 block">
                Username
              </label>
              <Input
                id="auth-ntlm-username"
                value={n?.username ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    ntlm: { ...(n ?? { username: '', password: '' }), username: e.target.value },
                  })
                }
                placeholder="Enter username"
                className="bg-background border-border"
              />
            </div>
            <div>
              <label htmlFor="auth-ntlm-password" className="text-sm font-medium mb-2 block">
                Password
              </label>
              <SecretInput
                id="auth-ntlm-password"
                value={n?.password}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    ntlm: { ...(n ?? { username: '', password: '' }), password: next },
                  })
                }
                placeholder="Enter password"
                storageLabel="ntlm.password"
              />
            </div>
            <div>
              <label htmlFor="auth-ntlm-domain" className="text-sm font-medium mb-2 block">
                Domain (optional)
              </label>
              <Input
                id="auth-ntlm-domain"
                value={n?.domain ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    ntlm: { ...(n ?? { username: '', password: '' }), domain: e.target.value },
                  })
                }
                placeholder="e.g., CORP"
                className="bg-background border-border"
              />
            </div>
            <div>
              <label htmlFor="auth-ntlm-workstation" className="text-sm font-medium mb-2 block">
                Workstation (optional)
              </label>
              <Input
                id="auth-ntlm-workstation"
                value={n?.workstation ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    ntlm: { ...(n ?? { username: '', password: '' }), workstation: e.target.value },
                  })
                }
                placeholder="Workstation name"
                className="bg-background border-border"
              />
            </div>
          </div>
        );
      }

      case 'wsse': {
        const w = auth.wsse;
        const passwordType = w?.passwordType ?? 'PasswordDigest';
        return (
          <div className="space-y-4">
            <div>
              <label htmlFor="auth-wsse-username" className="text-sm font-medium mb-2 block">
                Username
              </label>
              <Input
                id="auth-wsse-username"
                value={w?.username ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    wsse: { ...(w ?? { username: '', password: '' }), username: e.target.value },
                  })
                }
                placeholder="Enter username"
                className="bg-background border-border"
              />
            </div>
            <div>
              <label htmlFor="auth-wsse-password" className="text-sm font-medium mb-2 block">
                Password
              </label>
              <SecretInput
                id="auth-wsse-password"
                value={w?.password}
                onChange={(next) =>
                  onChange({
                    ...auth,
                    wsse: { ...(w ?? { username: '', password: '' }), password: next },
                  })
                }
                placeholder="Enter password"
                storageLabel="wsse.password"
              />
            </div>
            <div>
              <label htmlFor="auth-wsse-password-type" className="text-sm font-medium mb-2 block">
                Password Type
              </label>
              <Select
                value={passwordType}
                onValueChange={(v) =>
                  onChange({
                    ...auth,
                    wsse: {
                      ...(w ?? { username: '', password: '' }),
                      passwordType: v as 'PasswordDigest' | 'PasswordText',
                    },
                  })
                }
              >
                <SelectTrigger id="auth-wsse-password-type" className="bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PasswordDigest">PasswordDigest (recommended)</SelectItem>
                  <SelectItem value="PasswordText">PasswordText (clear)</SelectItem>
                </SelectContent>
              </Select>
              {passwordType === 'PasswordText' && (
                <p
                  className="text-xs text-amber-500 flex items-center gap-1 mt-2"
                  data-testid="wsse-password-text-warning"
                >
                  <AlertTriangle className="h-3 w-3" />
                  PasswordText sends the password in the clear over the wire. Prefer PasswordDigest.
                </p>
              )}
            </div>
          </div>
        );
      }

      case 'none':
      default:
        return (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="mb-2 inline-flex items-center justify-center h-9 w-9 rounded-full bg-sp-surface-lo text-sp-dim">
              <Lock size={16} />
            </div>
            <p className="text-sp-13 text-sp-muted font-medium">No authentication</p>
            <p className="text-sp-11 text-sp-dim mt-1 max-w-[260px]">
              Choose an authentication method to configure credentials for this request.
            </p>
          </div>
        );
    }
  };

  return <div className="space-y-5">{renderAuthFields()}</div>;
}
