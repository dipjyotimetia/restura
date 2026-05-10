'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import type { AuthConfig, AuthType } from '@/types';
import { Lock, Loader2, AlertTriangle } from 'lucide-react';
import { isElectron } from '@/lib/shared/platform';
import {
  fetchClientCredentialsToken,
  fetchPasswordToken,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  authorizeWithPopup,
  fetchDeviceCode,
  pollForDeviceToken,
} from '@/features/auth/lib/oauth2';

interface AuthConfigProps {
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
}

export default function AuthConfiguration({ auth, onChange }: AuthConfigProps) {
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<{ userCode: string; verificationUri: string } | null>(null);

  const handleTypeChange = (type: AuthType) => {
    onChange({ type });
  };

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
      const config = {
        grantType: o.grantType,
        clientId: o.clientId,
        clientSecret: o.clientSecret,
        tokenUrl: o.tokenUrl,
        authorizationUrl: o.authorizationUrl,
        deviceAuthorizationUrl: o.deviceAuthorizationUrl,
        redirectUri: o.redirectUri,
        scope: o.scope,
        username: o.username,
        password: o.password,
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
        const res = await pollForDeviceToken(config, device.device_code, device.interval ?? 5, Math.ceil(device.expires_in / (device.interval ?? 5)));
        token = res.access_token;
        tokenType = res.token_type;
        setDeviceCodeInfo(null);
      } else {
        setTokenError('Unsupported grant type');
        return;
      }

      onChange({ ...auth, oauth2: { ...auth.oauth2!, accessToken: token, tokenType } });
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to get token');
    } finally {
      setTokenLoading(false);
    }
  };

  const renderAuthFields = () => {
    switch (auth.type) {
      case 'basic':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Username</label>
              <Input
                value={auth.basic?.username || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    basic: { ...auth.basic!, username: e.target.value },
                  })
                }
                placeholder="Enter username"
                className="bg-background border-border"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Password</label>
              <Input
                type="password"
                value={auth.basic?.password || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    basic: { ...auth.basic!, password: e.target.value },
                  })
                }
                placeholder="Enter password"
                className="bg-background border-border"
              />
            </div>
          </div>
        );

      case 'bearer':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Token</label>
              <Input
                value={auth.bearer?.token || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    bearer: { token: e.target.value },
                  })
                }
                placeholder="Enter bearer token"
                className="font-mono bg-background border-border"
              />
            </div>
          </div>
        );

      case 'api-key':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Key</label>
              <Input
                value={auth.apiKey?.key || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    apiKey: { ...auth.apiKey!, key: e.target.value },
                  })
                }
                placeholder="e.g., X-API-Key"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Value</label>
              <Input
                value={auth.apiKey?.value || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    apiKey: { ...auth.apiKey!, value: e.target.value },
                  })
                }
                placeholder="Enter API key value"
                className="font-mono"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Add to</label>
              <Select
                value={auth.apiKey?.in || 'header'}
                onValueChange={(value: 'header' | 'query') =>
                  onChange({
                    ...auth,
                    apiKey: { ...auth.apiKey!, in: value },
                  })
                }
              >
                <SelectTrigger>
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

      case 'oauth2': {
        const o = auth.oauth2;
        const grantType = o?.grantType ?? 'authorization_code';
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Grant Type</label>
              <Select
                value={grantType}
                onValueChange={(v) => onChange({ ...auth, oauth2: { ...o!, grantType: v as typeof grantType } })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="authorization_code">Authorization Code (PKCE)</SelectItem>
                  <SelectItem value="client_credentials">Client Credentials</SelectItem>
                  <SelectItem value="password">Password</SelectItem>
                  <SelectItem value="device_code">Device Code</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Client ID</label>
              <Input value={o?.clientId ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, clientId: e.target.value } })} placeholder="Enter client ID" />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Client Secret</label>
              <Input type="password" value={o?.clientSecret ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, clientSecret: e.target.value } })} placeholder="Enter client secret (optional for PKCE)" />
            </div>
            {grantType === 'authorization_code' && (
              <div>
                <label className="text-sm font-medium mb-2 block">Authorization URL</label>
                <Input value={o?.authorizationUrl ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, authorizationUrl: e.target.value } })} placeholder="https://auth.example.com/authorize" className="font-mono" />
              </div>
            )}
            {grantType === 'device_code' && (
              <div>
                <label className="text-sm font-medium mb-2 block">Device Authorization URL</label>
                <Input value={o?.deviceAuthorizationUrl ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, deviceAuthorizationUrl: e.target.value } })} placeholder="https://auth.example.com/device_authorization" className="font-mono" />
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-2 block">Token URL</label>
              <Input value={o?.tokenUrl ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, tokenUrl: e.target.value } })} placeholder="https://auth.example.com/token" className="font-mono" />
            </div>
            {grantType === 'authorization_code' && (
              <div>
                <label className="text-sm font-medium mb-2 block">Redirect URI</label>
                <Input value={o?.redirectUri ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, redirectUri: e.target.value } })} placeholder="https://your-app.com/callback" className="font-mono" />
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-2 block">Scope (optional)</label>
              <Input value={o?.scope ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, scope: e.target.value } })} placeholder="openid email profile" />
            </div>
            {grantType === 'password' && (
              <>
                <div>
                  <label className="text-sm font-medium mb-2 block">Username</label>
                  <Input value={o?.username ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, username: e.target.value } })} placeholder="Username" />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Password</label>
                  <Input type="password" value={o?.password ?? ''} onChange={(e) => onChange({ ...auth, oauth2: { ...o!, password: e.target.value } })} placeholder="Password" />
                </div>
              </>
            )}
            <Button variant="outline" size="sm" onClick={handleGetToken} disabled={tokenLoading} className="w-full">
              {tokenLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {tokenLoading ? 'Getting Token...' : 'Get New Access Token'}
            </Button>
            {deviceCodeInfo && (
              <div className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs space-y-1">
                <p className="font-medium">Device Authorization Required</p>
                <p>Go to <span className="font-mono text-primary">{deviceCodeInfo.verificationUri}</span></p>
                <p>Enter code: <span className="font-mono font-bold text-primary">{deviceCodeInfo.userCode}</span></p>
                <p className="text-muted-foreground">Waiting for authorization...</p>
              </div>
            )}
            {tokenError && <p className="text-xs text-red-500">{tokenError}</p>}
            <div className="border-t border-border pt-4">
              <label className="text-sm font-medium mb-2 block">Access Token</label>
              <Input
                value={o?.accessToken ?? ''}
                onChange={(e) => onChange({ ...auth, oauth2: { ...o!, accessToken: e.target.value } })}
                placeholder="Token will appear here after authorization"
                className="font-mono"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Token Type (optional)</label>
              <Input
                value={o?.tokenType ?? ''}
                onChange={(e) => onChange({ ...auth, oauth2: { ...o!, tokenType: e.target.value } })}
                placeholder="Bearer"
              />
            </div>
          </div>
        );
      }

      case 'digest':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Username</label>
              <Input
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
              <label className="text-sm font-medium mb-2 block">Password</label>
              <Input
                type="password"
                value={auth.digest?.password || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    digest: { ...auth.digest!, password: e.target.value },
                  })
                }
                placeholder="Enter password"
              />
            </div>
          </div>
        );

      case 'aws-signature':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Access Key</label>
              <Input
                value={auth.awsSignature?.accessKey || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...auth.awsSignature!, accessKey: e.target.value },
                  })
                }
                placeholder="Enter AWS access key"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Secret Key</label>
              <Input
                type="password"
                value={auth.awsSignature?.secretKey || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...auth.awsSignature!, secretKey: e.target.value },
                  })
                }
                placeholder="Enter AWS secret key"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Region</label>
              <Input
                value={auth.awsSignature?.region || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...auth.awsSignature!, region: e.target.value },
                  })
                }
                placeholder="e.g., us-east-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Service</label>
              <Input
                value={auth.awsSignature?.service || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...auth.awsSignature!, service: e.target.value },
                  })
                }
                placeholder="e.g., execute-api"
              />
            </div>
          </div>
        );

      case 'oauth1': {
        const o = auth.oauth1;
        const signatureMethod = o?.signatureMethod ?? 'HMAC-SHA1';
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Consumer Key</label>
              <Input
                value={o?.consumerKey ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth1: { ...(o ?? { consumerKey: '', consumerSecret: '' }), consumerKey: e.target.value },
                  })
                }
                placeholder="Enter consumer key"
                className="font-mono bg-background border-border"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Consumer Secret</label>
              <Input
                type="password"
                value={o?.consumerSecret ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth1: { ...(o ?? { consumerKey: '', consumerSecret: '' }), consumerSecret: e.target.value },
                  })
                }
                placeholder="Enter consumer secret"
                className="font-mono bg-background border-border"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Access Token (optional)</label>
              <Input
                value={o?.accessToken ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth1: { ...(o ?? { consumerKey: '', consumerSecret: '' }), accessToken: e.target.value },
                  })
                }
                placeholder="Enter access token"
                className="font-mono bg-background border-border"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Access Token Secret (optional)</label>
              <Input
                type="password"
                value={o?.accessTokenSecret ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth1: { ...(o ?? { consumerKey: '', consumerSecret: '' }), accessTokenSecret: e.target.value },
                  })
                }
                placeholder="Enter access token secret"
                className="font-mono bg-background border-border"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Signature Method</label>
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
                <SelectTrigger className="bg-background border-border">
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
              <label className="text-sm font-medium mb-2 block">Realm (optional)</label>
              <Input
                value={o?.realm ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth1: { ...(o ?? { consumerKey: '', consumerSecret: '' }), realm: e.target.value },
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
              <label htmlFor="oauth1-add-params-to-body" className="text-sm font-medium cursor-pointer">
                Include body params in signature (RFC 5849 §3.4.1.3.1)
              </label>
            </div>
          </div>
        );
      }

      case 'ntlm': {
        const n = auth.ntlm;
        const inElectron = isElectron();
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge variant={inElectron ? 'info' : 'warning'} data-testid="ntlm-platform-badge">
                Desktop only
              </Badge>
              {!inElectron && (
                <p className="text-xs text-amber-500 flex items-center gap-1" data-testid="ntlm-web-warning">
                  <AlertTriangle className="h-3 w-3" />
                  Will not run in browser; use the desktop app.
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Username</label>
              <Input
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
              <label className="text-sm font-medium mb-2 block">Password</label>
              <Input
                type="password"
                value={n?.password ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    ntlm: { ...(n ?? { username: '', password: '' }), password: e.target.value },
                  })
                }
                placeholder="Enter password"
                className="bg-background border-border"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Domain (optional)</label>
              <Input
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
              <label className="text-sm font-medium mb-2 block">Workstation (optional)</label>
              <Input
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
              <label className="text-sm font-medium mb-2 block">Username</label>
              <Input
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
              <label className="text-sm font-medium mb-2 block">Password</label>
              <Input
                type="password"
                value={w?.password ?? ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    wsse: { ...(w ?? { username: '', password: '' }), password: e.target.value },
                  })
                }
                placeholder="Enter password"
                className="bg-background border-border"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Password Type</label>
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
                <SelectTrigger className="bg-background border-border">
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
          <div className="text-center py-8 text-muted-foreground">
            <Lock className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>This request does not use any authentication.</p>
            <p className="text-sm mt-1">Select an auth type above to get started.</p>
          </div>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="text-sm font-medium mb-2 block">Auth Type</label>
        <Select value={auth.type} onValueChange={(value) => handleTypeChange(value as AuthType)}>
          <SelectTrigger className="bg-background border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No Auth</SelectItem>
            <SelectItem value="basic">Basic Auth</SelectItem>
            <SelectItem value="bearer">Bearer Token</SelectItem>
            <SelectItem value="api-key">API Key</SelectItem>
            <SelectItem value="oauth2">OAuth 2.0</SelectItem>
            <SelectItem value="oauth1">OAuth 1.0</SelectItem>
            <SelectItem value="digest">Digest Auth</SelectItem>
            <SelectItem value="aws-signature">AWS Signature</SelectItem>
            <SelectItem value="ntlm">NTLM</SelectItem>
            <SelectItem value="wsse">WSSE</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {renderAuthFields()}
    </div>
  );
}
