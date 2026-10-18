import {
  isMcpOAuthFlow,
  MCP_DESKTOP_ONLY_AUTH_TYPES,
  MCP_EDITOR_AUTH_TYPES,
  MCP_OAUTH_DESKTOP_ONLY_MESSAGE,
  mcpAuthUnsupportedReason,
} from '@shared/protocol/mcp-auth';
import { Segmented } from '@/components/ui/spatial';
import { ApiKeyAuthEditor } from '@/features/auth/components/editors/ApiKeyAuthEditor';
import { BearerAuthEditor } from '@/features/auth/components/editors/BearerAuthEditor';
import { UnappliedAuthNotice } from '@/features/auth/components/editors/UnappliedAuthNotice';
import { InheritedAuthHint, useInheritedAuth } from '@/features/auth/components/InheritedAuthHint';
import { McpOAuthEditor } from '@/features/mcp/components/McpOAuthEditor';
import { isElectron } from '@/lib/shared/platform';
import type { AuthConfig, AuthType } from '@/types';

type McpEditorAuthType = (typeof MCP_EDITOR_AUTH_TYPES)[number];

const LABELS: Record<McpEditorAuthType, string> = {
  none: 'None',
  bearer: 'Bearer',
  'api-key': 'API Key',
  oauth2: 'OAuth 2.1',
};

/** OAuth sign-in is desktop-only (ADR 0031); the web selector hides it. */
function typeOptionsFor(desktop: boolean) {
  return MCP_EDITOR_AUTH_TYPES.filter(
    (value) => desktop || !MCP_DESKTOP_ONLY_AUTH_TYPES.has(value)
  ).map((value) => ({ value, label: LABELS[value] }));
}

/** Editor-owned auth: the three header types, plus oauth2 only as the MCP sign-in flow. */
function isEditorAuth(auth: AuthConfig): auth is AuthConfig & { type: McpEditorAuthType } {
  if (auth.type === 'oauth2') return isMcpOAuthFlow(auth);
  return (MCP_EDITOR_AUTH_TYPES as readonly string[]).includes(auth.type as AuthType);
}

/** Switching type keeps only that type's block so stale credentials don't linger. */
function authForType(type: McpEditorAuthType, current: AuthConfig): AuthConfig {
  switch (type) {
    case 'bearer':
      return { type, bearer: current.bearer ?? { token: '' } };
    case 'api-key':
      return {
        type,
        apiKey: { ...(current.apiKey ?? { key: 'X-API-Key', value: '' }), in: 'header' },
      };
    case 'oauth2':
      return {
        type,
        oauth2: {
          accessToken: '',
          grantType: 'authorization_code',
          ...(isMcpOAuthFlow(current) && current.oauth2
            ? {
                ...(current.oauth2.clientId ? { clientId: current.oauth2.clientId } : {}),
                ...(current.oauth2.clientSecret
                  ? { clientSecret: current.oauth2.clientSecret }
                  : {}),
                ...(current.oauth2.scope ? { scope: current.oauth2.scope } : {}),
                ...(current.oauth2.redirectUri ? { redirectUri: current.oauth2.redirectUri } : {}),
              }
            : {}),
        },
      };
    default:
      return { type: 'none' };
  }
}

interface McpAuthPanelProps {
  /** The MCP request (id drives folder/collection auth inheritance). */
  requestId: string;
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
  disabled?: boolean;
  /** MCP server URL (raw, may contain `{{vars}}`) — scopes the OAuth sign-in status. */
  serverUrl?: string;
}

/**
 * MCP connection auth editor (#896): None / Bearer / API-key header, reusing
 * the HTTP auth editors and their SecretRef-aware `SecretInput` (ADR-0007) —
 * on desktop a credential can be stored as an OS-keychain handle and is
 * resolved by Electron main at connect time; on web it is inline-only and is
 * never written to IndexedDB (re-enter after reload).
 */
export function McpAuthPanel({
  requestId,
  auth,
  onChange,
  disabled,
  serverUrl = '',
}: McpAuthPanelProps) {
  const desktop = isElectron();
  const inherited = useInheritedAuth({ id: requestId, auth });
  const ownReason = mcpAuthUnsupportedReason(auth);
  const inheritedReason = inherited ? mcpAuthUnsupportedReason(inherited.auth) : undefined;
  const editorAuth = isEditorAuth(auth) ? auth : null;
  const oauthFlow = isMcpOAuthFlow(auth);

  return (
    <div className="space-y-3" data-testid="mcp-auth-panel">
      <InheritedAuthHint request={{ id: requestId, auth }} />
      <Segmented<McpEditorAuthType>
        options={typeOptionsFor(desktop)}
        value={
          editorAuth && (desktop || !MCP_DESKTOP_ONLY_AUTH_TYPES.has(editorAuth.type))
            ? editorAuth.type
            : 'none'
        }
        onChange={(type) => onChange(authForType(type, auth))}
        size="sm"
        ariaLabel="MCP auth type"
        className={disabled ? 'opacity-60 pointer-events-none' : undefined}
      />
      {auth.type === 'bearer' && <BearerAuthEditor auth={auth} onChange={onChange} />}
      {oauthFlow && desktop && (
        <McpOAuthEditor
          auth={auth}
          onChange={onChange}
          serverUrl={serverUrl}
          {...(disabled !== undefined ? { disabled } : {})}
        />
      )}
      {oauthFlow && !desktop && (
        <UnappliedAuthNotice message={MCP_OAUTH_DESKTOP_ONLY_MESSAGE} testId="mcp-oauth-web" />
      )}
      {auth.type === 'api-key' && (
        <ApiKeyAuthEditor
          auth={auth}
          // MCP credentials never ride the query string.
          onChange={(next) =>
            onChange(next.apiKey ? { ...next, apiKey: { ...next.apiKey, in: 'header' } } : next)
          }
          headerOnly
        />
      )}
      {!editorAuth && ownReason && (
        <UnappliedAuthNotice
          message={`${ownReason} Connecting will fail until you pick another type.`}
          testId="mcp-auth-unsupported"
        />
      )}
      {!editorAuth && !ownReason && (
        <p className="text-sp-11 text-sp-muted font-mono" data-testid="mcp-auth-imported">
          This request carries imported {auth.type} auth, sent as an Authorization header. Pick a
          type above to replace it.
        </p>
      )}
      {inheritedReason && (
        <UnappliedAuthNotice
          message={`The inherited auth isn’t applied to MCP: ${inheritedReason}`}
          testId="mcp-auth-inherited-unsupported"
        />
      )}
      {auth.type !== 'none' && !oauthFlow && (
        <p className="text-sp-11 text-sp-muted font-mono" data-testid="mcp-auth-storage-note">
          {desktop
            ? 'Store the credential in the OS keychain to keep it out of saved data — Restura resolves it at connect time.'
            : 'The browser build doesn’t save this MCP request’s own credentials (auth token, credential headers) — re-enter them after a reload.'}
        </p>
      )}
    </div>
  );
}
