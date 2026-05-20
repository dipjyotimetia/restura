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
 * field name. The list below mirrors `AuthConfig`'s secret-bearing fields
 * exactly. Adding a new auth descriptor with a secret? Add its field name
 * here in the SAME PR.
 */

import { redactSecret, isSecretHandle } from '@/lib/shared/secretRef';

/**
 * Field names that carry secrets in `AuthConfig`. The redactor wipes any
 * field on any object with one of these names, regardless of nesting depth.
 * Lowercased for case-insensitive matching.
 */
const SECRET_FIELD_NAMES = new Set([
  // Basic / digest / NTLM / WSSE
  'password',
  // Bearer / OAuth2 access
  'token',
  'accesstoken',
  'refreshtoken',
  // OAuth2 client
  'clientsecret',
  // OAuth1
  'consumersecret',
  'accesstokensecret',
  // AWS SigV4
  'secretkey',
  'secretaccesskey',
  'sessiontoken',
  // API key
  'apikey',
  // mTLS / cert
  'privatekey',
  'passphrase',
  // Generic
  'secret',
  'credential',
]);

/**
 * Walk the value, redacting any field whose name matches a secret name.
 * Returns the input unchanged when no secrets are present, or a fresh tree
 * with secrets blanked otherwise — `list_collections` against a benign
 * collection (the common case) skips the rebuild.
 */
export function redactSecretsDeep<T>(value: T): T {
  if (!containsSecretField(value, new WeakSet())) return value;
  return redactInner(value, new WeakSet()) as T;
}

/** Pre-scan for any secret-named key anywhere in the tree. */
function containsSecretField(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.some((v) => containsSecretField(v, seen));
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) return true;
    if (containsSecretField(v, seen)) return true;
  }
  return false;
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return null; // break cycles
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      out[key] = redactValueAtSecretField(v);
    } else {
      out[key] = redactInner(v, seen);
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
