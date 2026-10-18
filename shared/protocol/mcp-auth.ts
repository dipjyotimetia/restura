/**
 * MCP connection auth policy (#896, SEC-3) — the single, backend-agnostic
 * answer to "which `AuthConfig` can an MCP connection carry, and where may it
 * go on the wire". Consumed by the renderer (web harness applies inline auth
 * as `/api/mcp` spec headers), Electron main (resolves SecretRef handles at
 * connect time, ADR-0007) and the CLI executor, so the three harnesses can't
 * drift.
 *
 * MCP authenticates with HTTP headers only (MCP 2025-06-18 Authorization:
 * `Authorization: Bearer <token>`; servers commonly also accept an API-key
 * header). Credentials MUST NOT ride the query string, and sign-at-wire
 * schemes (Digest, OAuth 1.0, AWS SigV4, NTLM, WSSE) have no MCP analogue.
 *
 * OAuth 2.1 for MCP (#856, ADR 0031): an `oauth2` auth WITHOUT an access
 * token is the interactive MCP authorization flow ({@link isMcpOAuthFlow}) —
 * PKCE, protected-resource metadata discovery, dynamic or static client
 * registration, tokens held only in Electron main. It is desktop-only
 * ({@link MCP_DESKTOP_ONLY_AUTH_TYPES}). An `oauth2` auth that already
 * carries an access token (imported / inherited) keeps the plain header path:
 * `Authorization: <tokenType> <token>`.
 */

/** Auth types the MCP auth editor offers. Order is the selector order. */
export const MCP_EDITOR_AUTH_TYPES = ['none', 'bearer', 'api-key', 'oauth2'] as const;

export type McpEditorAuthType = (typeof MCP_EDITOR_AUTH_TYPES)[number];

/**
 * Editor types only the desktop harness can run: the OAuth flow needs a
 * system browser, a loopback redirect listener and main-process token
 * storage (ADR 0031). The web editor hides them.
 */
export const MCP_DESKTOP_ONLY_AUTH_TYPES: ReadonlySet<McpEditorAuthType> = new Set(['oauth2']);

/** Structural view of the OAuth fields the MCP flow reads. */
export interface McpOAuthLike {
  type: string;
  oauth2?:
    | {
        accessToken?: unknown;
        grantType?: string | undefined;
        clientId?: string | undefined;
        scope?: string | undefined;
        redirectUri?: string | undefined;
      }
    | undefined;
}

/**
 * True when `auth` asks for the interactive MCP OAuth 2.1 flow: `oauth2`,
 * `grantType: 'authorization_code'` (what the MCP editor writes) and no
 * access token of its own (empty string / absent / empty inline ref). An
 * oauth2 auth that carries a token (or a handle / external ref to one) is a
 * static header instead; other grant types keep their existing handling
 * (e.g. the CLI's client_credentials fetch).
 */
export function isMcpOAuthFlow(auth: McpOAuthLike | undefined): boolean {
  if (auth?.type !== 'oauth2' || auth.oauth2?.grantType !== 'authorization_code') return false;
  const token = auth.oauth2?.accessToken;
  if (token === undefined || token === null || token === '') return true;
  if (typeof token === 'object') {
    const ref = token as { kind?: unknown; value?: unknown };
    return ref.kind === 'inline' && (ref.value === undefined || ref.value === '');
  }
  return false;
}

export const MCP_OAUTH_DESKTOP_ONLY_MESSAGE =
  'MCP OAuth sign-in needs the Restura desktop app (system browser + loopback redirect, tokens kept in the OS keychain). In the browser, paste an access token as Bearer auth instead.';

/**
 * Header-shaped auth types every harness applies to an MCP connection. A
 * superset of the editor types: `basic` / `oauth2` (with an access token) can
 * arrive from an imported or inherited collection auth and are applied as a
 * plain `Authorization` header — the same thing the CLI has always done.
 */
const MCP_WIRE_AUTH_TYPES: ReadonlySet<string> = new Set([
  'none',
  'bearer',
  'api-key',
  'basic',
  'oauth2',
]);

const AUTH_LABELS: Record<string, string> = {
  basic: 'Basic',
  bearer: 'Bearer',
  'api-key': 'API Key',
  oauth2: 'OAuth 2.0',
  oauth1: 'OAuth 1.0',
  digest: 'Digest',
  'aws-signature': 'AWS Signature',
  ntlm: 'NTLM',
  wsse: 'WSSE',
};

export function mcpAuthLabel(type: string): string {
  return AUTH_LABELS[type] ?? type;
}

/** Minimal structural view — works for `AuthConfig` and `ProtocolAuthConfig`. */
export interface McpAuthLike {
  type: string;
  apiKey?: { in?: string } | undefined;
}

/**
 * Why `auth` can't be applied to an MCP connection, or `undefined` when it
 * can. Callers fail closed on a reason — never open an unauthenticated
 * session for a request that configured credentials.
 */
export function mcpAuthUnsupportedReason(auth: McpAuthLike | undefined): string | undefined {
  if (!auth || auth.type === 'none') return undefined;
  if (!MCP_WIRE_AUTH_TYPES.has(auth.type)) {
    return `${mcpAuthLabel(auth.type)} auth isn't supported for MCP connections — MCP authenticates with a header (Bearer token or API key).`;
  }
  if (auth.type === 'api-key' && auth.apiKey?.in === 'query') {
    return 'MCP API keys must be sent as a header — credentials in the query string are not allowed for MCP connections.';
  }
  return undefined;
}

/**
 * Headers the MCP transport owns. Applied auth (e.g. an API key whose header
 * name is `Mcp-Session-Id`) must never set them — they'd break session
 * tracking / protocol negotiation or the request framing.
 */
const MCP_TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'content-type',
  'content-length',
  'accept',
  'host',
]);

export function isMcpTransportHeader(name: string): boolean {
  return MCP_TRANSPORT_HEADERS.has(name.trim().toLowerCase());
}

/**
 * Folder / collection auth inheritance for MCP, shared by the renderer and
 * the CLI collection loader. The request's own configured auth always wins
 * (and is NOT filtered — an unsupported own auth fails closed at connect).
 * An inherited scheme MCP can't carry (e.g. AWS SigV4 set for the HTTP
 * siblings) is skipped rather than blocking every MCP request in the folder;
 * `skippedReason` lets the UI explain why.
 */
export function resolveMcpEffectiveAuth<T extends McpAuthLike>(
  own: T | undefined,
  inherited: T | undefined
): { auth: T | undefined; skippedReason?: string } {
  if (own && own.type !== 'none') return { auth: own };
  if (!inherited || inherited.type === 'none') return { auth: own };
  const reason = mcpAuthUnsupportedReason(inherited);
  return reason ? { auth: own, skippedReason: reason } : { auth: inherited };
}
