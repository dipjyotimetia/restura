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
 * recipient re-enters the credential. The same rule applies to the text rows
 * of a structured urlencoded / form-data body (`request-secret-slots.ts`,
 * Q29). Secret material inside a free-form *request body* (e.g. a JSON
 * `{"api_key":"…"}`) is intentionally out of scope: auto-rewriting arbitrary
 * bodies risks corrupting them; that residual is documented in the export flow.
 *
 * Imports only a flat string list from `@shared` (resolves under both the
 * renderer and the Electron main tsconfigs), so it stays portable across both.
 */

import { CREDENTIAL_HEADER_NAMES } from '@shared/protocol/credential-header-names';

export interface SecretableRow {
  key: string;
  value: string;
  secret?: boolean;
}

// Full header/param names that are always credentials: the shared base set
// (kept in sync with the AI-context redactor) plus export-specific extras.
const SECRET_NAME_EXACT = new Set([
  ...CREDENTIAL_HEADER_NAMES,
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
  'apitoken',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'privatekey',
  'signature',
  'sig',
  'cookie',
  'sas',
  'otp',
  'totp',
  // Gateway-style credential headers (`X-Auth`, `X-MCP-Auth`, `X-Gateway-Authz`).
  // Whole-segment match only, so `X-Author` / `authorName` stay visible.
  'auth',
  'authz',
]);

// Too common to match anywhere (`pass_rate`, `pw_policy`), but a credential as the
// last word of a name (`db_pass`, `PG_PW`).
const TRAILING_SECRET_SEGMENTS = new Set(['pass', 'pw']);

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

/** The innermost name of a bracketed key and what holds it: `auth[password]`, `a[secret][]`. */
function splitFieldName(name: string): { leaf: string; parent: string } {
  let leaf = name.trim();
  while (leaf.endsWith(']')) {
    const open = leaf.lastIndexOf('[');
    if (open === -1) break;
    const inner = leaf.slice(open + 1, -1).trim();
    const before = leaf.slice(0, open).trim();
    if (inner) return { leaf: inner, parent: before };
    leaf = before;
  }
  return { leaf, parent: '' };
}

/** Names built from a credential word that say how, not what (`authSource`, `token_type`). */
const NON_CREDENTIAL_NAMES = new Set(['auth_source', 'auth_mechanism', 'token_type']);

function isAmbiguousOnly(segs: readonly string[]): boolean {
  return segs.length > 0 && segs.every((s) => AMBIGUOUS_SEGMENTS.has(s));
}

function isSecretPlainName(name: string): boolean {
  const lower = name.toLowerCase();
  const segs = nameSegments(name);
  if (NON_CREDENTIAL_NAMES.has(segs.join('_'))) return false;
  if (SECRET_NAME_EXACT.has(lower)) return true;
  if (segs.some((s) => SECRET_SEGMENTS.has(s))) return true;
  if (TRAILING_SECRET_SEGMENTS.has(segs.at(-1) ?? '')) return true;
  if (segs.some((s) => AMBIGUOUS_SEGMENTS.has(s)) && !segs.some((s) => BENIGN_QUALIFIERS.has(s))) {
    return true;
  }
  return false;
}

/**
 * True when a header/param/metadata key name looks credential-bearing. In a
 * bracketed name the inner word decides; `key` and `token` alone are structural
 * there (`filter[key]`) unless what holds them is itself a credential word.
 */
export function isSecretFieldName(name: string): boolean {
  const { leaf, parent } = splitFieldName(name);
  if (!isSecretPlainName(leaf)) return false;
  if (parent === '' || !isAmbiguousOnly(nameSegments(leaf))) return true;
  const holder = splitFieldName(parent).leaf;
  return isSecretPlainName(holder) && !isAmbiguousOnly(nameSegments(holder));
}

const VARIABLE_NAME_EXEMPT_SUFFIXES = ['public_key', 'cache_key', 'token_type'];
const URL_NAME_ENDINGS = new Set(['url', 'uri']);

/**
 * {@link isSecretFieldName} for variables, whose names are broader than header
 * names: a name ending in `_URL` / `_URI` holds an address (its value still gets
 * URL redaction), and a few common names hold no credential.
 */
export function isSecretVariableName(name: string): boolean {
  const segs = nameSegments(splitFieldName(name).leaf);
  if (URL_NAME_ENDINGS.has(segs.at(-1) ?? '')) return false;
  const joined = segs.join('_');
  if (VARIABLE_NAME_EXEMPT_SUFFIXES.some((s) => joined === s || joined.endsWith(`_${s}`))) {
    return false;
  }
  return isSecretFieldName(name);
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
