import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SecretInput from '@/features/auth/components/SecretInput';
import { getElectronAPI } from '@/lib/shared/platform';
import { unwrapSecret } from '@/lib/shared/secretRef';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { AuthConfig } from '@/types';

interface OAuthStatus {
  signedIn: boolean;
  canRefresh: boolean;
  expiresAt?: number;
  scope?: string;
  dynamicallyRegistered: boolean;
}

interface McpOAuthEditorProps {
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
  /** MCP server URL (may contain `{{vars}}`) — the protected resource. */
  serverUrl: string;
  disabled?: boolean;
}

type OAuth2Block = NonNullable<AuthConfig['oauth2']>;

/**
 * MCP OAuth 2.1 sign-in configuration (#856, desktop only). Only flow
 * settings live here; Electron main discovers the authorization server,
 * registers the client (RFC 7591) when no client id is given, runs the PKCE
 * browser sign-in and keeps the tokens in the OS keychain — the renderer only
 * ever sees a plaintext-free status.
 */
export function McpOAuthEditor({ auth, onChange, serverUrl, disabled }: McpOAuthEditorProps) {
  const oauth2: OAuth2Block = auth.oauth2 ?? { accessToken: '', grantType: 'authorization_code' };
  const update = (patch: Partial<OAuth2Block>) =>
    onChange({ ...auth, oauth2: { ...oauth2, ...patch, accessToken: '' } });
  const resolveVariables = useEnvironmentStore((state) => state.resolveVariables);
  const resolvedUrl = resolveVariables(serverUrl).trim();
  const clientId = oauth2.clientId?.trim() ?? '';
  const [status, setStatus] = useState<OAuthStatus | null>(null);

  const refresh = useCallback(async () => {
    const api = getElectronAPI()?.mcp;
    if (!api?.oauthStatus || !/^https?:\/\//i.test(resolvedUrl)) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await api.oauthStatus({ url: resolvedUrl, ...(clientId ? { clientId } : {}) }));
    } catch {
      setStatus(null);
    }
  }, [resolvedUrl, clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = async () => {
    const api = getElectronAPI()?.mcp;
    if (!api?.oauthSignOut || !resolvedUrl) return;
    await api.oauthSignOut({ url: resolvedUrl, ...(clientId ? { clientId } : {}) });
    await refresh();
  };

  return (
    <div className="space-y-3" data-testid="mcp-oauth-editor">
      <div>
        <label htmlFor="mcp-oauth-client-id" className="text-sm font-medium mb-1.5 block">
          Client ID
        </label>
        <Input
          id="mcp-oauth-client-id"
          value={oauth2.clientId ?? ''}
          onChange={(event) => update({ clientId: event.target.value })}
          placeholder="Leave empty to register dynamically"
          className="font-mono"
          disabled={disabled}
        />
      </div>
      {clientId && (
        <div>
          <label htmlFor="mcp-oauth-client-secret" className="text-sm font-medium mb-1.5 block">
            Client secret <span className="text-sp-muted font-normal">(confidential clients)</span>
          </label>
          <SecretInput
            id="mcp-oauth-client-secret"
            value={oauth2.clientSecret}
            onChange={(clientSecret) =>
              update(unwrapSecret(clientSecret) === '' ? { clientSecret: '' } : { clientSecret })
            }
            placeholder="Optional — public clients use PKCE only"
            storageLabel="mcp.oauth2.clientSecret"
          />
        </div>
      )}
      <div>
        <label htmlFor="mcp-oauth-scope" className="text-sm font-medium mb-1.5 block">
          Scope
        </label>
        <Input
          id="mcp-oauth-scope"
          value={oauth2.scope ?? ''}
          onChange={(event) => update({ scope: event.target.value })}
          placeholder="Optional — defaults to what the server advertises"
          className="font-mono"
          disabled={disabled}
        />
      </div>
      <div>
        <label htmlFor="mcp-oauth-redirect" className="text-sm font-medium mb-1.5 block">
          Redirect URI
        </label>
        <Input
          id="mcp-oauth-redirect"
          value={oauth2.redirectUri ?? ''}
          onChange={(event) => update({ redirectUri: event.target.value })}
          placeholder="Optional — http://127.0.0.1:<port>/callback if your client requires one"
          className="font-mono"
          disabled={disabled}
        />
      </div>
      <div
        className="flex items-center justify-between gap-2 text-sp-11 font-mono text-sp-muted"
        data-testid="mcp-oauth-status"
      >
        <span>
          {status?.signedIn
            ? `Signed in${status.expiresAt ? ` · token expires ${new Date(status.expiresAt).toLocaleTimeString()}` : ''}${status.canRefresh ? ' · auto-refresh' : ''}`
            : 'Not signed in — Connect opens your browser to sign in.'}
        </span>
        {(status?.signedIn || status?.dynamicallyRegistered) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-sp-11"
            onClick={() => void signOut()}
            disabled={disabled}
          >
            Sign out
          </Button>
        )}
      </div>
    </div>
  );
}
