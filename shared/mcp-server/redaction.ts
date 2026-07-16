/**
 * MCP-server output redaction.
 *
 * Every tool output crosses the trust boundary into the agent's context.
 * If Restura is configured as an MCP server in Claude Desktop, the agent
 * sees whatever we return — including any plaintext secrets that happen
 * to be in a collection's auth descriptors.
 *
 * Until the per-descriptor `SecretRef` migration is complete (see
 * ADR-0007), we redact at the MCP output boundary by walking the object
 * tree and zeroing out any field whose path matches a well-known secret
 * field name. The auth field names are derived from the canonical
 * `SECRET_FIELDS_BY_AUTH_BLOCK` map so this redactor cannot drift from
 * the export redactors when a new auth descriptor is added.
 */

import { SECRET_FIELDS_BY_AUTH_BLOCK } from '../secrets/auth-fields';
import { isSecretHandle, redactSecret } from '../secrets/secret-ref';

/**
 * Canonical secret-bearing auth field names, lowercased for case-insensitive
 * matching. `value` (the apiKey credential) is far too generic to wipe on
 * every object — env-var listings are `{ key, value }` — so it is only
 * redacted inside an `auth` subtree (see AUTH_ONLY_SECRET_FIELD_NAMES).
 */
const CANONICAL_AUTH_FIELD_NAMES = new Set(
  Object.values(SECRET_FIELDS_BY_AUTH_BLOCK)
    .flat()
    .map((f) => f.toLowerCase())
);

/** Redacted anywhere in a tool output, regardless of nesting. */
const GLOBAL_SECRET_FIELD_NAMES = new Set([
  ...[...CANONICAL_AUTH_FIELD_NAMES].filter((n) => n !== 'value'),
  // Extra generic / defense-in-depth names beyond the auth blocks.
  'secretaccesskey',
  'sessiontoken',
  'privatekey',
  'passphrase',
  'secret',
  'credential',
]);

/** Redacted only when the field sits inside an `auth` subtree. */
const AUTH_ONLY_SECRET_FIELD_NAMES = new Set(
  [...CANONICAL_AUTH_FIELD_NAMES].filter((n) => !GLOBAL_SECRET_FIELD_NAMES.has(n))
);

function isSecretFieldName(key: string, inAuth: boolean): boolean {
  const k = key.toLowerCase();
  return GLOBAL_SECRET_FIELD_NAMES.has(k) || (inAuth && AUTH_ONLY_SECRET_FIELD_NAMES.has(k));
}

/** A key that roots an auth descriptor subtree. */
function isAuthKey(key: string): boolean {
  return key.toLowerCase() === 'auth';
}

/**
 * Walk the value, redacting any field whose name matches a secret name.
 * Returns the input unchanged when no secrets are present, or a fresh tree
 * with secrets blanked otherwise — `list_collections` against a benign
 * collection (the common case) skips the rebuild.
 */
export function redactSecretsDeep<T>(value: T): T {
  if (!containsSecretField(value, new WeakSet(), false)) return value;
  return redactInner(value, new WeakSet(), false) as T;
}

/** Pre-scan for any secret-named key anywhere in the tree. */
function containsSecretField(value: unknown, seen: WeakSet<object>, inAuth: boolean): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.some((v) => containsSecretField(v, seen, inAuth));
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretFieldName(key, inAuth)) return true;
    if (containsSecretField(v, seen, inAuth || isAuthKey(key))) return true;
  }
  return false;
}

function redactInner(value: unknown, seen: WeakSet<object>, inAuth: boolean): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return null; // break cycles
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, seen, inAuth));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretFieldName(key, inAuth)) {
      out[key] = redactValueAtSecretField(v);
    } else {
      out[key] = redactInner(v, seen, inAuth || isAuthKey(key));
    }
  }
  return out;
}

function redactValueAtSecretField(value: unknown): unknown {
  // Already a SecretRef? Use the shared helper.
  if (value && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
    const ref = value as { kind: string };
    if (ref.kind === 'inline' || ref.kind === 'handle') {
      const redacted = redactSecret(value as Parameters<typeof redactSecret>[0]);
      // For agent-readable output, surface "handle" references with their
      // label so the agent can ask the user about a specific credential.
      if (typeof redacted === 'object' && isSecretHandle(redacted)) {
        return {
          kind: 'handle' as const,
          label: redacted.label ?? '(unnamed)',
        };
      }
      return redacted;
    }
  }
  // Plain string / number / etc. at a secret field — replace with empty.
  return '';
}

/**
 * Credential-bearing query parameter names — values are replaced, the
 * parameter itself stays so the agent can still see it exists.
 */
const SECRET_QUERY_PARAM_RE =
  /^(api[-_]?key|access[-_]?token|token|secret|signature|sig|key|password|auth)$/i;

/**
 * Strip credential material embedded in a URL before it crosses the MCP
 * boundary: `user:pass@host` userinfo is dropped and known credential query
 * params are masked. Non-URL strings pass through unchanged.
 */
export function redactUrlCredentials(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    for (const name of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_PARAM_RE.test(name)) u.searchParams.set(name, '(secret)');
    }
    return u.toString();
  } catch {
    // Not an absolute URL (templated {{base}}/path etc.) — leave as-is; the
    // interesting leak vector is a concrete user:pass@host / ?token= URL.
    return url;
  }
}

/**
 * Environment variables are key/value pairs where the value may itself be
 * a secret. We expose names (so an agent can ask "set foo to bar"), but
 * the values get an opaque "(secret)" placeholder if the variable is
 * marked as such, or are passed through if not.
 *
 * Mirrors Postman's environment "secret" flag handling.
 */
export interface RedactedEnvironmentVariable {
  key: string;
  value: string;
  isSecret: boolean;
}

export function redactEnvironmentVariables(
  vars: Array<{ key: string; value: string; enabled?: boolean; secret?: boolean }>
): RedactedEnvironmentVariable[] {
  return vars
    .filter((v) => v.enabled !== false)
    .map((v) => ({
      key: v.key,
      value: v.secret ? '(secret)' : v.value,
      isSecret: v.secret === true,
    }));
}
