/**
 * Redacts secret-bearing request *headers / query params / metadata* before a
 * collection is exported, written to a git-backed file, or shared. The typed
 * auth-block redactors (`collection-secret-redaction.ts`,
 * `electron/main/security/collection-export-redactor.ts`) only cover the `auth`
 * descriptor — a token typed directly into an `Authorization` header, an
 * `?api_key=` query param, or a row flagged `secret` would otherwise leave the
 * machine as plaintext.
 *
 * A row is treated as secret when it is explicitly flagged `secret`, or when
 * its key name matches a credential pattern. Redaction blanks the value and
 * keeps the row so the export still round-trips the request shape — the
 * recipient re-enters the credential. Secret material in the *request body*
 * (e.g. `{"api_key":"…"}`) is intentionally out of scope here: auto-rewriting
 * arbitrary bodies risks corrupting them; that residual is documented in the
 * export flow.
 *
 * Dependency-free (a minimal structural row type, no `@/` alias) so both the
 * renderer and the Electron main process can import it under their own
 * tsconfigs.
 */

export interface SecretableRow {
  key: string;
  value: string;
  secret?: boolean;
}

// Full header/param names that are always credentials.
const SECRET_NAME_EXACT = new Set([
  'authorization',
  'authentication',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-amz-security-token',
  'x-functions-key',
  'api-key',
  'apikey',
  'api_key',
  'private-token',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'password',
  'secret',
  'sig',
  'signature',
]);

// A single name segment that, on its own, marks the field as a credential.
const SECRET_SEGMENTS = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'jwt',
  'bearer',
  'apikey',
  'privatekey',
  'signature',
  'sig',
  'cookie',
  'sas',
  'otp',
  'totp',
]);

// `token` / `key` are credential-bearing UNLESS qualified by a pagination or
// structural word — so `accessToken`/`apiKey`/`x-goog-api-key` redact while
// `page_token`/`sortKey`/`idempotencyKey` do not. This is what the old
// separator-anchored regex got wrong both ways: it missed camelCase
// (`accessToken`) and blanked pagination cursors (`page_token`).
const AMBIGUOUS_SEGMENTS = new Set(['token', 'key']);
const BENIGN_QUALIFIERS = new Set([
  'page',
  'next',
  'prev',
  'previous',
  'continuation',
  'cursor',
  'scroll',
  'offset',
  'sort',
  'primary',
  'partition',
  'foreign',
  'composite',
  'range',
  'row',
  'idempotency',
  'request',
  'correlation',
  'trace',
  'span',
  'dedup',
  'sync',
  'etag',
]);

/** Split a key into lowercase word segments across camelCase, kebab, and snake. */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

/** True when a header/param/metadata key name looks credential-bearing. */
export function isSecretFieldName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (SECRET_NAME_EXACT.has(lower)) return true;
  const segs = nameSegments(name);
  if (segs.some((s) => SECRET_SEGMENTS.has(s))) return true;
  if (segs.some((s) => AMBIGUOUS_SEGMENTS.has(s)) && !segs.some((s) => BENIGN_QUALIFIERS.has(s))) {
    return true;
  }
  return false;
}

function rowIsSecret(row: SecretableRow): boolean {
  return row.secret === true || isSecretFieldName(row.key);
}

/** Blank the value of every secret-bearing row; non-secret rows pass through. */
export function redactSecretKeyValues<T extends SecretableRow>(
  rows: readonly T[] | undefined
): T[] | undefined {
  if (!rows) return rows as T[] | undefined;
  return rows.map((row) => (rowIsSecret(row) && row.value !== '' ? { ...row, value: '' } : row));
}

/** Count secret-bearing rows that still hold a non-empty plaintext value. */
export function countSecretKeyValues(rows: readonly SecretableRow[] | undefined): number {
  if (!rows) return 0;
  return rows.reduce((n, row) => (rowIsSecret(row) && row.value !== '' ? n + 1 : n), 0);
}
