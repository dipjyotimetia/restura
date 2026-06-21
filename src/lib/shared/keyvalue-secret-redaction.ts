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

// Segment-boundary patterns so `access_token` / `x-foo-secret` match while
// innocuous names that merely contain the substring (e.g. `monkey`) do not.
const SECRET_NAME_REGEX: RegExp[] = [
  /(^|[-_])token($|[-_])/i,
  /(^|[-_])secret($|[-_])/i,
  /(^|[-_])pass(word|wd|phrase)?($|[-_])/i,
  /(^|[-_])credentials?($|[-_])/i,
  /(^|[-_])auth($|[-_])/i,
  /api[-_]?key/i,
  /access[-_]?key/i,
];

/** True when a header/param/metadata key name looks credential-bearing. */
export function isSecretFieldName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (SECRET_NAME_EXACT.has(lower)) return true;
  return SECRET_NAME_REGEX.some((re) => re.test(lower));
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
