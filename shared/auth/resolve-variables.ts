import type { SecretValue } from '../secrets/secret-ref';
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

function resolveSecret(value: SecretValue, resolve: (text: string) => string): SecretValue {
  if (typeof value === 'string') return resolve(value);
  if (value.kind === 'inline') {
    const next = resolve(value.value);
    return next === value.value ? value : { ...value, value: next };
  }
  return value;
}

export function resolveAuthVariables(
  auth: AuthConfig,
  resolve: (text: string) => string
): AuthConfig {
  const blockKey = BLOCK_BY_TYPE[auth.type];
  if (!blockKey) return auth;
  const block = auth[blockKey] as Record<string, unknown> | undefined;
  if (!block) return auth;

  let changed = false;
  const next: Record<string, unknown> = { ...block };
  for (const field of TEXT_FIELDS[blockKey] as readonly string[]) {
    const value = block[field];
    if (typeof value !== 'string') continue;
    const resolved = resolve(value);
    if (resolved !== value) {
      next[field] = resolved;
      changed = true;
    }
  }
  for (const field of SECRET_FIELDS[blockKey] as readonly string[]) {
    const value = block[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'object') continue;
    const resolved = resolveSecret(value as SecretValue, resolve);
    if (resolved !== value) {
      next[field] = resolved;
      changed = true;
    }
  }
  return changed ? ({ ...auth, [blockKey]: next } as AuthConfig) : auth;
}
