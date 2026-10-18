/**
 * Persistence for MCP OAuth credentials (#856, ADR 0031).
 *
 * One record per (MCP server resource, client id | dynamic registration):
 * the access + refresh tokens, a DCR registration (client id / secret /
 * registered redirect URI) and the token expiry. The whole record is one
 * `internal:mcp-oauth` handle in the encrypted, OS-keychain-keyed secret
 * handle store (ADR-0007) — never Dexie, never the renderer's electron-store
 * slice, never the renderer. `resolveSecretHandle` (the path renderer-supplied
 * handle refs take) refuses internal records, and `secret:store` can't
 * overwrite them; the renderer can delete one (Settings → Secrets, or the MCP
 * auth panel's "Sign out" via `mcp:oauth:signOut`).
 *
 * Statically configured client secrets are NOT copied here: they stay in the
 * user's own SecretRef handle and are resolved at connect time.
 */

import * as crypto from 'node:crypto';
import type { StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';
import {
  deleteSecretHandle,
  resolveInternalSecretHandle,
  storeInternalSecretHandle,
} from './secret-handle-store';

export const MCP_OAUTH_SECRET_SCOPE = 'internal:mcp-oauth';

export interface McpOAuthRecord {
  v: 1;
  /** Canonical resource URL (origin + path) the credentials are bound to. */
  resource: string;
  /** Static client id, or absent for a dynamically registered client. */
  staticClientId?: string;
  /** DCR registration (RFC 7591 response), stamped with its issuer. */
  registration?: StoredOAuthClientInformation;
  /** Static public client: issuer pinned on the first successful sign-in. */
  staticClientIssuer?: string;
  /** Redirect URI the DCR registration was made with (port reuse). */
  registeredRedirectUrl?: string;
  tokens?: StoredOAuthTokens;
  /** Epoch ms the access token expires at, from `expires_in` when saved. */
  expiresAt?: number;
  updatedAt: number;
}

/** Credentials bind to the resource: origin + path, no query / fragment. */
export function canonicalMcpResource(serverUrl: string): string {
  const url = new URL(serverUrl);
  return `${url.origin}${url.pathname}`;
}

/**
 * Deterministic, UUID-shaped (version 8, RFC 9562 custom) handle id so the
 * record can be found again on the next connect without an index, and so the
 * Settings → Secrets UI can delete it through the uuid-validated channel.
 */
export function mcpOAuthHandleId(serverUrl: string, clientId: string | undefined): string {
  const hex = crypto
    .createHash('sha256')
    .update(JSON.stringify(['mcp-oauth', canonicalMcpResource(serverUrl), clientId ?? '']))
    .digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function label(serverUrl: string): string {
  return `MCP OAuth · ${new URL(serverUrl).host}`;
}

export function loadMcpOAuthRecord(
  serverUrl: string,
  clientId: string | undefined
): McpOAuthRecord | undefined {
  const raw = resolveInternalSecretHandle(
    mcpOAuthHandleId(serverUrl, clientId),
    MCP_OAUTH_SECRET_SCOPE
  );
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as McpOAuthRecord;
    if (parsed?.v !== 1 || parsed.resource !== canonicalMcpResource(serverUrl)) return undefined;
    if ((parsed.staticClientId ?? '') !== (clientId ?? '')) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveMcpOAuthRecord(
  serverUrl: string,
  clientId: string | undefined,
  patch: Partial<Omit<McpOAuthRecord, 'v' | 'resource' | 'staticClientId' | 'updatedAt'>>
): McpOAuthRecord {
  const current = loadMcpOAuthRecord(serverUrl, clientId);
  const next: McpOAuthRecord = {
    ...(current ?? {}),
    ...patch,
    v: 1,
    resource: canonicalMcpResource(serverUrl),
    ...(clientId ? { staticClientId: clientId } : {}),
    updatedAt: Date.now(),
  };
  for (const key of Object.keys(next) as Array<keyof McpOAuthRecord>) {
    if (next[key] === undefined) delete next[key];
  }
  storeInternalSecretHandle({
    id: mcpOAuthHandleId(serverUrl, clientId),
    value: JSON.stringify(next),
    scope: MCP_OAUTH_SECRET_SCOPE,
    label: label(serverUrl),
  });
  return next;
}

export function clearMcpOAuthRecord(serverUrl: string, clientId: string | undefined): void {
  deleteSecretHandle(mcpOAuthHandleId(serverUrl, clientId));
}

/** Plaintext-free status for the renderer. */
export interface McpOAuthStatus {
  signedIn: boolean;
  /** A refresh token is held (the session can renew without the browser). */
  canRefresh: boolean;
  expiresAt?: number;
  scope?: string;
  /** Client registered dynamically with the AS (RFC 7591). */
  dynamicallyRegistered: boolean;
}

export function mcpOAuthStatus(serverUrl: string, clientId: string | undefined): McpOAuthStatus {
  const record = loadMcpOAuthRecord(serverUrl, clientId);
  return {
    signedIn: Boolean(record?.tokens?.access_token),
    canRefresh: Boolean(record?.tokens?.refresh_token),
    ...(record?.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    ...(record?.tokens?.scope ? { scope: record.tokens.scope } : {}),
    dynamicallyRegistered: Boolean(record?.registration),
  };
}
