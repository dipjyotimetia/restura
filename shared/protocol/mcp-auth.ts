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
 * Extension point: OAuth 2.1 for MCP (#856 — PKCE, protected-resource
 * metadata discovery, dynamic client registration, tokens held as SecretRef
 * handles in main) adds `'oauth2'` to {@link MCP_EDITOR_AUTH_TYPES} and owns
 * token acquisition; the wire path below already applies an `oauth2` access
 * token as `Authorization: <tokenType> <token>`.
 */

/**
 * Auth types the MCP auth editor offers. Order is the selector order.
 * #856 appends `'oauth2'` here.
 */
export const MCP_EDITOR_AUTH_TYPES = ['none', 'bearer', 'api-key'] as const;

export type McpEditorAuthType = (typeof MCP_EDITOR_AUTH_TYPES)[number];

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
