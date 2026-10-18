import { MCP_EDITOR_AUTH_TYPES, mcpAuthUnsupportedReason } from '@shared/protocol/mcp-auth';
import { Segmented } from '@/components/ui/spatial';
import { ApiKeyAuthEditor } from '@/features/auth/components/editors/ApiKeyAuthEditor';
import { BearerAuthEditor } from '@/features/auth/components/editors/BearerAuthEditor';
import { UnappliedAuthNotice } from '@/features/auth/components/editors/UnappliedAuthNotice';
import { InheritedAuthHint, useInheritedAuth } from '@/features/auth/components/InheritedAuthHint';
import { isElectron } from '@/lib/shared/platform';
import type { AuthConfig, AuthType } from '@/types';

type McpEditorAuthType = (typeof MCP_EDITOR_AUTH_TYPES)[number];

const LABELS: Record<McpEditorAuthType, string> = {
  none: 'None',
  bearer: 'Bearer',
  'api-key': 'API Key',
};

const typeOptions = MCP_EDITOR_AUTH_TYPES.map((value) => ({ value, label: LABELS[value] }));

function isEditorType(type: AuthType): type is McpEditorAuthType {
  return (MCP_EDITOR_AUTH_TYPES as readonly string[]).includes(type);
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
}

/**
 * MCP connection auth editor (#896): None / Bearer / API-key header, reusing
 * the HTTP auth editors and their SecretRef-aware `SecretInput` (ADR-0007) —
 * on desktop a credential can be stored as an OS-keychain handle and is
 * resolved by Electron main at connect time; on web it is inline-only and is
 * never written to IndexedDB (re-enter after reload).
 */
export function McpAuthPanel({ requestId, auth, onChange, disabled }: McpAuthPanelProps) {
  const desktop = isElectron();
  const inherited = useInheritedAuth({ id: requestId, auth });
  const ownReason = mcpAuthUnsupportedReason(auth);
  const inheritedReason = inherited ? mcpAuthUnsupportedReason(inherited.auth) : undefined;
  const editorAuth = isEditorType(auth.type) ? auth : null;

  return (
    <div className="space-y-3" data-testid="mcp-auth-panel">
      <InheritedAuthHint request={{ id: requestId, auth }} />
      <Segmented<McpEditorAuthType>
        options={typeOptions}
        value={editorAuth ? (auth.type as McpEditorAuthType) : 'none'}
        onChange={(type) => onChange(authForType(type, auth))}
        size="sm"
        ariaLabel="MCP auth type"
        className={disabled ? 'opacity-60 pointer-events-none' : undefined}
      />
      {auth.type === 'bearer' && <BearerAuthEditor auth={auth} onChange={onChange} />}
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
      {auth.type !== 'none' && (
        <p className="text-sp-11 text-sp-muted font-mono" data-testid="mcp-auth-storage-note">
          {desktop
            ? 'Store the credential in the OS keychain to keep it out of saved data — Restura resolves it at connect time.'
            : 'For your safety the browser build doesn’t save MCP credentials — re-enter them after a reload.'}
        </p>
      )}
    </div>
  );
}
