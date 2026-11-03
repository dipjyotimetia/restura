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

import { redactVariableValue, scanUrlCredentials } from '../collections/postman/text-redaction';
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

/** Fields holding a URL or address, lowercased: their credentials go, the rest stays. */
const URL_FIELD_NAMES = new Set([
  'url',
  'tokenurl',
  'authorizationurl',
  'deviceauthorizationurl',
  'accesstokenurl',
  'refreshtokenurl',
  'brokerurl',
  'endpoint',
  'redirecturi',
  'callbackurl',
  'issuer',
]);

function urlFieldChanges(key: string, value: unknown): value is string {
  return (
    URL_FIELD_NAMES.has(key.toLowerCase()) &&
    typeof value === 'string' &&
    redactUrlCredentials(value) !== value
  );
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
    if (isSecretFieldName(key, inAuth) || urlFieldChanges(key, v)) return true;
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
    } else if (urlFieldChanges(key, v)) {
      out[key] = redactUrlCredentials(v);
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
 * Strip credential material embedded in a URL before it crosses the MCP
 * boundary, with the shared rule. Credential values are replaced rather than
 * blanked, so the agent can still see the parameter exists.
 */
export function redactUrlCredentials(url: string | undefined): string | undefined {
  if (!url) return url;
  return scanUrlCredentials(url, { mask: '%28secret%29' }).redacted;
}

/**
 * Environment variables are key/value pairs where the value may itself be
 * a secret. We expose names (so an agent can ask "set foo to bar"), but
 * the values get an opaque "(secret)" placeholder if the variable is marked
 * as such or credential-named, and any other value loses URL credentials.
 *
 * Mirrors Postman's environment "secret" flag handling.
 */
export interface RedactedEnvironmentVariable {
  key: string;
  value: string;
  isSecret: boolean;
}

const SECRET_PLACEHOLDER = '(secret)';

export function redactEnvironmentVariables(
  vars: Array<{ key: string; value: string; enabled?: boolean; secret?: boolean }>
): RedactedEnvironmentVariable[] {
  return vars
    .filter((v) => v.enabled !== false)
    .map((v) => {
      const value = v.secret
        ? SECRET_PLACEHOLDER
        : redactVariableValue(v.key, v.value, SECRET_PLACEHOLDER);
      return { key: v.key, value, isSecret: v.secret === true || value === SECRET_PLACEHOLDER };
    });
}

// ---------------------------------------------------------------------------
// Response redaction for the control server's send tools (ADR 0041)
// ---------------------------------------------------------------------------

/** Response/request headers whose values are credentials. Compared lowercased. */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'set-cookie2',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  'x-goog-api-key',
  'www-authenticate',
  'proxy-authenticate',
]);

export const REDACTED = '(redacted)';

/** Mask credential-bearing headers; everything else passes through. */
export function redactHeadersForAgent(
  headers: Record<string, string | string[] | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers ?? {})) {
    if (raw === undefined) continue;
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
    out[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/** Normalise a JSON key for token-likeness: lowercase, separators dropped. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const TOKEN_LIKE_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'sessionid',
  'sid',
  'jwt',
  'bearer',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apikey',
  'apisecret',
  'privatekey',
  'authorization',
  'cookie',
  'otp',
  'mfacode',
]);

function isTokenLikeKey(key: string): boolean {
  const k = normaliseKey(key);
  if (TOKEN_LIKE_KEYS.has(k)) return true;
  return k.endsWith('token') || k.endsWith('secret') || k.endsWith('password');
}

/** Compact JWTs (three base64url segments, header starting `eyJ`). */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

interface RedactCounter {
  count: number;
}

function redactJwts(text: string, counter: RedactCounter): string {
  return text.replace(JWT_PATTERN, () => {
    counter.count += 1;
    return '(redacted-jwt)';
  });
}

function redactJsonValue(value: unknown, depth: number, counter: RedactCounter): unknown {
  if (depth > 64) {
    counter.count += 1;
    return REDACTED;
  }
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, depth + 1, counter));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isTokenLikeKey(key) && (typeof v === 'string' || typeof v === 'number')) {
        counter.count += 1;
        out[key] = REDACTED;
      } else {
        out[key] = redactJsonValue(v, depth + 1, counter);
      }
    }
    return out;
  }
  if (typeof value === 'string') return redactJwts(value, counter);
  return value;
}

export interface AgentBody {
  /** Body text the agent sees: redacted (when enabled), then truncated. */
  text: string;
  /** Characters in the body before redaction and truncation. */
  originalLength: number;
  truncated: boolean;
  /** Number of values masked by redaction. */
  redactions: number;
}

export interface AgentBodyOptions {
  /** Redact token-like JSON fields and JWT-shaped strings. */
  redact: boolean;
  /** Truncate to this many characters (after redaction). */
  maxChars: number;
}

/**
 * Prepare a response body for an agent: token-like JSON fields and JWTs are
 * masked (when `redact`), and the result is capped at `maxChars`. JSON bodies
 * that needed redaction are re-serialised; everything else keeps its exact
 * text apart from masked JWTs. Never throws.
 */
export function redactBodyForAgent(body: string | undefined, options: AgentBodyOptions): AgentBody {
  const source = typeof body === 'string' ? body : '';
  const counter: RedactCounter = { count: 0 };
  let text = source;
  if (options.redact && source.length > 0) {
    const trimmed = source.trimStart();
    let handled = false;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(source);
        const cleaned = redactJsonValue(parsed, 0, counter);
        if (counter.count > 0) text = JSON.stringify(cleaned, null, 2);
        handled = true;
      } catch {
        handled = false;
      }
    }
    if (!handled) text = redactJwts(source, counter);
  }
  const truncated = text.length > options.maxChars;
  return {
    text: truncated ? text.slice(0, options.maxChars) : text,
    originalLength: source.length,
    truncated,
    redactions: counter.count,
  };
}
