import type { AuthConfig, AuthType } from '../types';

/**
 * `{{var}}` resolution for every `AuthConfig` block — the single place that
 * knows which auth fields are user-entered text. Shared by the renderer
 * executor (HTTP / GraphQL / MCP / subscriptions) and the CLI so a template
 * like `Bearer {{token}}` or a Digest password `{{pw}}` resolves identically
 * everywhere, including the sign-at-wire schemes (SigV4 / OAuth1 / WSSE /
 * Digest / NTLM) whose descriptor travels in `spec.auth`.
 *
 * Secret fields (`SecretValue`): plain strings and `{ kind: 'inline' }` refs
 * are resolved; `handle` / `external` refs are opaque to the caller
 * (ADR-0007) and pass through by reference for the main process to resolve at
 * wire time. Enum / numeric / boolean fields (`in`, `grantType`,
 * `signatureMethod`, `expiresAt`, …) are never touched.
 *
 * Pure: never mutates the input. Returns the SAME object when nothing changed
 * so callers can cheaply detect a no-op.
 */

type AuthBlockKey = Exclude<keyof AuthConfig, 'type'>;

const BLOCK_BY_TYPE: Partial<Record<AuthType, AuthBlockKey>> = {
  basic: 'basic',
  bearer: 'bearer',
  'api-key': 'apiKey',
  oauth2: 'oauth2',
  digest: 'digest',
  'aws-signature': 'awsSignature',
  oauth1: 'oauth1',
  ntlm: 'ntlm',
  wsse: 'wsse',
};

/** Plain-string, user-entered fields per block. */
const TEXT_FIELDS = {
  basic: ['username'],
  bearer: [],
  apiKey: ['key'],
  oauth2: [
    'tokenType',
    'clientId',
    'authorizationUrl',
    'tokenUrl',
    'deviceAuthorizationUrl',
    'scope',
    'redirectUri',
    'issuer',
    'username',
  ],
  digest: ['username'],
  awsSignature: ['accessKey', 'region', 'service'],
  oauth1: ['consumerKey', 'realm', 'nonce', 'timestamp'],
  ntlm: ['username', 'domain', 'workstation'],
  wsse: ['username'],
} as const satisfies Record<AuthBlockKey, readonly string[]>;

/** `SecretValue` fields per block (mirrors `SECRET_FIELDS_BY_AUTH_BLOCK`). */
const SECRET_FIELDS = {
  basic: ['password'],
  bearer: ['token'],
  apiKey: ['value'],
  oauth2: ['accessToken', 'refreshToken', 'clientSecret', 'password'],
  digest: ['password'],
  awsSignature: ['secretKey'],
  oauth1: ['consumerSecret', 'accessToken', 'accessTokenSecret'],
  ntlm: ['password'],
  wsse: ['password'],
} as const satisfies Record<AuthBlockKey, readonly string[]>;

/**
 * Fields that are header / query-param NAMES rather than values. Callers that
 * substitute secret material (Electron main's secret-variable materializer)
 * skip these so a secret-derived name can't surface in header errors.
 */
const NAME_FIELDS: Partial<Record<AuthBlockKey, readonly string[]>> = {
  apiKey: ['key'],
};

function resolveSecret(value: unknown, resolve: (text: string) => string): unknown {
  if (typeof value === 'string') return resolve(value);
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'inline' &&
    typeof (value as { value?: unknown }).value === 'string'
  ) {
    const inline = value as { kind: 'inline'; value: string };
    const next = resolve(inline.value);
    return next === inline.value ? value : { ...inline, value: next };
  }
  // handle / external refs (and anything malformed) stay opaque.
  return value;
}

export interface ResolveAuthFieldOptions {
  /** Also resolve header/param NAME fields (`apiKey.key`). Default true. */
  includeNames?: boolean;
}

/**
 * Structural form of {@link resolveAuthVariables} for any auth-shaped object
 * keyed like `AuthConfig` (e.g. the wire-side `ProtocolAuthConfig`), so the
 * renderer, CLI and Electron main share one field map.
 */
export function resolveAuthFieldVariables<T extends { type: string }>(
  auth: T,
  resolve: (text: string) => string,
  options: ResolveAuthFieldOptions = {}
): T {
  const blockKey = BLOCK_BY_TYPE[auth.type as AuthType];
  if (!blockKey) return auth;
  const block = (auth as Record<string, unknown>)[blockKey];
  if (!block || typeof block !== 'object') return auth;
  const source = block as Record<string, unknown>;
  const skip = options.includeNames === false ? (NAME_FIELDS[blockKey] ?? []) : [];

  let changed = false;
  const next: Record<string, unknown> = { ...source };
  for (const field of TEXT_FIELDS[blockKey] as readonly string[]) {
    if (skip.includes(field)) continue;
    const value = source[field];
    if (typeof value !== 'string') continue;
    const resolved = resolve(value);
    if (resolved !== value) {
      next[field] = resolved;
      changed = true;
    }
  }
  for (const field of SECRET_FIELDS[blockKey] as readonly string[]) {
    const value = source[field];
    if (value === undefined) continue;
    const resolved = resolveSecret(value, resolve);
    if (resolved !== value) {
      next[field] = resolved;
      changed = true;
    }
  }
  return changed ? ({ ...auth, [blockKey]: next } as T) : auth;
}

export function resolveAuthVariables(
  auth: AuthConfig,
  resolve: (text: string) => string
): AuthConfig {
  return resolveAuthFieldVariables(auth, resolve);
}
