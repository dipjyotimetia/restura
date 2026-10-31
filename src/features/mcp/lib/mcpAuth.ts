/**
 * Effective connect-time credentials for an MCP request (#896, SEC-3).
 *
 * `McpRequest.auth` is applied on every harness:
 *   - **Web** (and self-host): inline credentials are resolved here and sent as
 *     `/api/mcp` spec headers. SecretRef handles / external refs can't be
 *     resolved in a browser, so the connect fails closed with a clear error.
 *   - **Desktop**: the header-shaped auth descriptor (handles stay handles)
 *     rides `mcp:connect` and Electron main resolves it at connect time
 *     (`electron/main/security/mcp-connect-auth.ts`) — the renderer never
 *     builds the credential header, and never sees handle plaintext.
 *   - **CLI**: `cli/src/runner/executors/mcp.ts`, same shared policy.
 *
 * Folder / collection auth is inherited when the request's own auth is
 * `none` (same rule as HTTP and the CLI collection runner). An inherited
 * scheme MCP can't carry (e.g. AWS SigV4 for the HTTP siblings) is skipped
 * with a notice; the request's OWN unsupported / empty auth fails closed.
 *
 * OAuth 2.1 (#856, ADR 0031): an `oauth2` auth without an access token is the
 * interactive MCP sign-in. Desktop forwards only the flow configuration
 * (client id, client-secret SecretRef, scope, redirect URI) — Electron main
 * runs discovery / registration / PKCE / refresh and keeps the tokens. Web
 * fails closed with a clear "desktop only" error.
 */
import {
  isMcpOAuthFlow,
  isMcpTransportHeader,
  MCP_OAUTH_DESKTOP_ONLY_MESSAGE,
  mcpAuthLabel,
  mcpAuthUnsupportedReason,
  resolveMcpEffectiveAuth,
} from '@shared/protocol/mcp-auth';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';
import { resolveAuthVariables } from '@/features/auth/lib/resolveAuthVariables';
import {
  isExternalSecretRef,
  isSecretHandle,
  type SecretValue,
  unwrapSecret,
} from '@/lib/shared/secretRef';
import type { AuthConfig } from '@/types';

export interface McpConnectAuthInput {
  /** The request's own auth. */
  auth: AuthConfig | undefined;
  /** Folder / collection auth the request inherits (only used when its own is `none`). */
  inherited?: { auth: AuthConfig; sourceName: string } | undefined;
  /** User headers, variables already resolved. */
  headers: Record<string, string>;
  /** `{{var}}` resolver applied to inline credential fields. */
  resolve: (text: string) => string;
  /** True on the Electron harness (handles resolve main-side). */
  desktop: boolean;
}

export type McpConnectAuth =
  | {
      ok: true;
      /** Headers to send. On web these include the applied credential. */
      headers: Record<string, string>;
      /** Desktop only: auth descriptor Electron main resolves at connect time. */
      mainSideAuth?: AuthConfig;
      /** Configured credentials that are deliberately not applied. */
      notices: string[];
    }
  | { ok: false; error: string };

/** Keep only the field the auth type uses — nothing else crosses IPC. */
export function pickMcpAuth(auth: AuthConfig): AuthConfig {
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', bearer: { token: auth.bearer?.token ?? '' } };
    case 'basic':
      return {
        type: 'basic',
        basic: { username: auth.basic?.username ?? '', password: auth.basic?.password ?? '' },
      };
    case 'api-key':
      return {
        type: 'api-key',
        apiKey: { key: auth.apiKey?.key ?? '', value: auth.apiKey?.value ?? '', in: 'header' },
      };
    case 'oauth2':
      if (isMcpOAuthFlow(auth)) {
        const o = auth.oauth2;
        return {
          type: 'oauth2',
          oauth2: {
            accessToken: '',
            grantType: 'authorization_code',
            ...(o?.clientId?.trim() ? { clientId: o.clientId.trim() } : {}),
            ...(o?.clientSecret && unwrapSecretValueOrRef(o.clientSecret)
              ? { clientSecret: o.clientSecret }
              : {}),
            ...(o?.scope?.trim() ? { scope: o.scope.trim() } : {}),
            ...(o?.redirectUri?.trim() ? { redirectUri: o.redirectUri.trim() } : {}),
            ...(o?.issuer?.trim() ? { issuer: o.issuer.trim() } : {}),
          },
        };
      }
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: auth.oauth2?.accessToken ?? '',
          ...(auth.oauth2?.tokenType ? { tokenType: auth.oauth2.tokenType } : {}),
        },
      };
    default:
      return { type: 'none' };
  }
}

function isOpaqueRef(value: SecretValue | undefined): boolean {
  return isSecretHandle(value) || isExternalSecretRef(value);
}

/** True when a secret field is set (inline non-empty, or any opaque ref). */
function unwrapSecretValueOrRef(value: SecretValue): boolean {
  return isOpaqueRef(value) || unwrapSecret(value) !== '';
}

/** The secret-bearing field of a picked header auth. */
function credentialField(auth: AuthConfig): SecretValue | undefined {
  switch (auth.type) {
    case 'bearer':
      return auth.bearer?.token;
    case 'basic':
      return auth.basic?.password;
    case 'api-key':
      return auth.apiKey?.value;
    case 'oauth2':
      return auth.oauth2?.accessToken;
    default:
      return undefined;
  }
}

/** Empty-credential message, or undefined when the credential is present. */
function missingCredential(auth: AuthConfig, desktop: boolean): string | undefined {
  const label = mcpAuthLabel(auth.type);
  const reentry = desktop
    ? ''
    : ' Browser builds don’t store MCP credentials between sessions — re-enter it before connecting.';
  if (auth.type === 'api-key' && !auth.apiKey?.key.trim()) {
    return 'API Key auth needs a header name.';
  }
  if (auth.type === 'basic') {
    // Same rule as the other hosts: an empty username with a password is `:password`.
    const password = auth.basic?.password;
    return auth.basic?.username || isOpaqueRef(password) || unwrapSecret(password) !== ''
      ? undefined
      : `Basic auth needs a username or a password.${reentry}`;
  }
  const field = credentialField(auth);
  if (isOpaqueRef(field) || unwrapSecret(field) !== '') return undefined;
  return `${label} auth is selected but its credential is empty.${reentry}`;
}

/** Header-name collision check (case-insensitive) — auth replaces a same-named user header. */
function mergeHeaders(
  base: Record<string, string>,
  applied: Record<string, string>
): Record<string, string> {
  const out = { ...base };
  for (const [key, value] of Object.entries(applied)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete out[existing];
    }
    out[key] = value;
  }
  return out;
}

export function buildMcpConnectAuth(input: McpConnectAuthInput): McpConnectAuth {
  const notices: string[] = [];
  const resolved = resolveMcpEffectiveAuth(input.auth, input.inherited?.auth);
  if (resolved.skippedReason && input.inherited) {
    notices.push(
      `Inherited ${mcpAuthLabel(input.inherited.auth.type)} auth from “${input.inherited.sourceName}” isn’t applied: ${resolved.skippedReason}`
    );
  }
  const effective: AuthConfig = resolved.auth ?? { type: 'none' };

  if (effective.type === 'none') return { ok: true, headers: input.headers, notices };

  const reason = mcpAuthUnsupportedReason(effective);
  if (reason) return { ok: false, error: reason };

  if (isMcpOAuthFlow(effective)) {
    // #856: browser sign-in + token storage need Electron main.
    if (!input.desktop) return { ok: false, error: MCP_OAUTH_DESKTOP_ONLY_MESSAGE };
    const picked = pickMcpAuth(resolveAuthVariables(effective, input.resolve));
    return { ok: true, headers: input.headers, mainSideAuth: picked, notices };
  }

  const picked = pickMcpAuth(resolveAuthVariables(effective, input.resolve));
  const missing = missingCredential(picked, input.desktop);
  if (missing) return { ok: false, error: missing };

  if (picked.type === 'api-key' && isMcpTransportHeader(picked.apiKey?.key ?? '')) {
    return {
      ok: false,
      error: `API Key header "${picked.apiKey?.key}" is reserved by the MCP transport.`,
    };
  }

  if (input.desktop) {
    // Electron main resolves inline values and handles alike — one wire path.
    return { ok: true, headers: input.headers, mainSideAuth: picked, notices };
  }

  if (isOpaqueRef(credentialField(picked))) {
    return {
      ok: false,
      error:
        'This MCP auth uses a keychain-stored or external secret, which only the Restura desktop app can resolve. Enter the credential inline to connect from the browser.',
    };
  }
  const credential = buildAuthCredential(picked);
  if (Object.keys(credential.headers).length === 0) {
    return { ok: false, error: `${mcpAuthLabel(picked.type)} auth produced no credential.` };
  }
  return { ok: true, headers: mergeHeaders(input.headers, credential.headers), notices };
}
