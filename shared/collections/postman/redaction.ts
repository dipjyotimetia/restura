import { isSecretFieldName } from '../../secrets/key-value-redaction';
import { isSecretHandle, type SecretValue } from '../../secrets/secret-ref';
import { MAX_COLLECTION_TREE_DEPTH } from '../passthrough-bags';
import {
  activeAuthBlock,
  mapPostmanAuthParams,
  mappedAuthParamsFor,
  postmanAuthParamEntries,
} from './auth';

/**
 * Secret redaction / counting for the `_postman` sidecar (ADR 0034).
 *
 * The sidecar (`./sidecar.ts`) is stored RAW: it holds Postman JSON for
 * constructs Restura cannot model (unsupported / approximated auth blocks,
 * saved responses with headers, cookies, bodies and original requests, item
 * and URL variables). It is redacted here on export and on handle conversion.
 * Unlike `_oc` it is per-node (never a whole-document copy), so every bag is
 * walked independently without double-counting.
 *
 * Invariant: {@link countPostmanBagInlineSecrets} counts exactly what
 * {@link redactPostmanBag} blanks (minus typed-model copies, counted there).
 * `shared/secrets/collection-redaction.ts` calls both for every bag.
 */

/**
 * Postman auth parameter keys that carry credential material, across every
 * auth type (incl. the unmodelled hawk / edgegrid / jwt / asap / akamai).
 * Any {@link isSecretFieldName} key is treated as a credential too.
 */
const POSTMAN_AUTH_SECRET_KEYS = new Set([
  'password',
  'token',
  'tokenSecret',
  'consumerSecret',
  'clientSecret',
  'clientToken',
  'accessToken',
  'refreshToken',
  'authKey',
  'secret',
  'secretKey',
  'sessionToken',
  'privateKey',
  'value',
]);

/** A value that is exactly one `{{var}}` reference — a pointer, not a secret. */
const SINGLE_VARIABLE_REFERENCE = /^\{\{\s*[^{}\s]+\s*\}\}$/;

type Raw = Record<string, unknown>;

function isObj(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyScalar(v: unknown): boolean {
  return (typeof v === 'string' && v !== '') || typeof v === 'number';
}

/**
 * Any non-empty value (string, number, boolean, object) under a credential
 * key, except a SecretRef handle: like the typed model, handles are opaque
 * pointers that are preserved by redaction and never counted (ADR-0007).
 */
function isCredentialValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '' && !isSecretHandle(v as SecretValue);
}

/** A plaintext credential value (a lone `{{var}}` reference is a pointer, not a secret). */
function isPlaintextValue(v: unknown): boolean {
  return (
    isNonEmptyScalar(v) && !(typeof v === 'string' && SINGLE_VARIABLE_REFERENCE.test(v.trim()))
  );
}

export function isPostmanAuthSecretKey(key: string): boolean {
  return POSTMAN_AUTH_SECRET_KEYS.has(key) || isSecretFieldName(key);
}

// ── auth ────────────────────────────────────────────────────────────────────

/** Blank every credential param in EVERY block of an auth object (incl. inactive siblings). */
export function redactPostmanAuth(auth: Raw): Raw {
  const next: Raw = { ...auth };
  for (const [key, block] of Object.entries(auth)) {
    if (key === 'type') continue;
    next[key] = mapPostmanAuthParams(block, (p) =>
      isPostmanAuthSecretKey(p.key) && isCredentialValue(p.value) ? '' : p.value
    );
  }
  return next;
}

/**
 * Credentials {@link redactPostmanAuth} would blank, across every block.
 * `bagOnly` (saved-response `originalRequest` auth) counts all of them.
 * Otherwise keys of the ACTIVE block that the importer copies into the typed
 * model are skipped — they are counted there — so only bag-only material
 * counts (an OAuth1 RSA `privateKey`, a hostile sibling block, …).
 */
function countPostmanAuthSecrets(auth: unknown, bagOnly: boolean): number {
  if (!isObj(auth)) return 0;
  const { type } = activeAuthBlock(auth);
  let n = 0;
  for (const [key, block] of Object.entries(auth)) {
    if (key === 'type') continue;
    const mapped = !bagOnly && key === type ? mappedAuthParamsFor(type) : undefined;
    n += postmanAuthParamEntries(block).filter(
      (p) => !mapped?.has(p.key) && isPostmanAuthSecretKey(p.key) && isCredentialValue(p.value)
    ).length;
  }
  return n;
}

// ── rows / headers ──────────────────────────────────────────────────────────

/** A Postman `{ key, value }` header / query / variable row holding a plaintext secret. */
function isPostmanSecretRow(row: unknown): boolean {
  if (!isObj(row) || !isNonEmptyScalar(row.value)) return false;
  if (row.type === 'secret' || row.secret === true) return true;
  return isPlaintextValue(row.value) && typeof row.key === 'string' && isSecretFieldName(row.key);
}

function redactPostmanRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => (isPostmanSecretRow(row) ? { ...(row as object), value: '' } : row));
}

function countPostmanRows(rows: unknown): number {
  return Array.isArray(rows) ? rows.filter(isPostmanSecretRow).length : 0;
}

const HEADER_LINE = /^([^:]+):(.*)$/;

function isSecretHeaderLine(line: string): boolean {
  const m = HEADER_LINE.exec(line);
  return !!m && isSecretFieldName((m[1] ?? '').trim()) && isPlaintextValue((m[2] ?? '').trim());
}

/** Headers as `[{ key, value }]`, a raw `"Key: Value\n…"` block, or a `{ Key: value }` map. */
function redactPostmanHeaders(header: unknown): unknown {
  if (Array.isArray(header)) return redactPostmanRows(header);
  if (typeof header === 'string') {
    return header
      .split('\n')
      .map((line) => (isSecretHeaderLine(line) ? `${line.slice(0, line.indexOf(':'))}: ` : line))
      .join('\n');
  }
  if (isObj(header)) {
    return Object.fromEntries(
      Object.entries(header).map(([k, v]) => [
        k,
        isSecretFieldName(k) && isPlaintextValue(v) ? '' : v,
      ])
    );
  }
  return header;
}

function countPostmanHeaders(header: unknown): number {
  if (Array.isArray(header)) return countPostmanRows(header);
  if (typeof header === 'string') return header.split('\n').filter(isSecretHeaderLine).length;
  if (isObj(header)) {
    return Object.entries(header).filter(([k, v]) => isSecretFieldName(k) && isPlaintextValue(v))
      .length;
  }
  return 0;
}

// ── URLs: userinfo + credential-named query params (string, `raw`, `auth`, `query`)

const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * Strip `user:pass@` userinfo and blank credential-named query values in a
 * URL string; templated URLs survive apart from the credential, and a value
 * that is one `{{var}}` reference is kept. Same policy as
 * `redactUrlCredentialsForStorage` (`shared/secrets/mcp-credential-redaction.ts`),
 * which cannot be imported here: that module depends on collection-redaction,
 * which depends on this one (runtime cycle).
 */
function redactUrlCredentialsForStorage(url: string): string {
  const out = url.replace(URL_USERINFO, '$1');
  const queryStart = out.indexOf('?');
  if (queryStart === -1) return out;
  const hashStart = out.indexOf('#', queryStart);
  const end = hashStart === -1 ? out.length : hashStart;
  const query = out
    .slice(queryStart + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const value = pair.slice(eq + 1);
      if (!value || SINGLE_VARIABLE_REFERENCE.test(decodeComponent(value).trim())) return pair;
      return isSecretFieldName(decodeComponent(pair.slice(0, eq))) ? `${pair.slice(0, eq)}=` : pair;
    })
    .join('&');
  return `${out.slice(0, queryStart + 1)}${query}${out.slice(end)}`;
}

function queryPairs(url: string): string[] {
  const q = url.indexOf('?');
  if (q === -1) return [];
  const hash = url.indexOf('#', q);
  return url.slice(q + 1, hash === -1 ? url.length : hash).split('&');
}

/** Exactly the number of edits {@link redactUrlCredentialsForStorage} makes to `url`. */
function countUrlStringSecrets(url: string): number {
  const redacted = redactUrlCredentialsForStorage(url);
  if (redacted === url) return 0;
  const withoutUserinfo = url.replace(URL_USERINFO, '$1');
  const before = queryPairs(withoutUserinfo);
  const after = queryPairs(redacted);
  return (withoutUserinfo === url ? 0 : 1) + before.filter((pair, i) => pair !== after[i]).length;
}

function redactUrlAuth(auth: Raw): Raw {
  return Object.fromEntries(
    Object.entries(auth).map(([k, v]) => [
      k,
      isPostmanAuthSecretKey(k) && isCredentialValue(v) ? '' : v,
    ])
  );
}

function redactPostmanUrl(url: unknown): unknown {
  if (typeof url === 'string') return redactUrlCredentialsForStorage(url);
  if (!isObj(url)) return url;
  const next: Raw = { ...url };
  if (url.query !== undefined) next.query = redactPostmanRows(url.query);
  if (typeof url.raw === 'string') next.raw = redactUrlCredentialsForStorage(url.raw);
  if (isObj(url.auth)) next.auth = redactUrlAuth(url.auth);
  return next;
}

function countPostmanUrl(url: unknown): number {
  if (typeof url === 'string') return countUrlStringSecrets(url);
  if (!isObj(url)) return 0;
  let n = countPostmanRows(url.query);
  if (typeof url.raw === 'string') n += countUrlStringSecrets(url.raw);
  if (isObj(url.auth)) {
    n += Object.entries(url.auth).filter(
      ([k, v]) => isPostmanAuthSecretKey(k) && isCredentialValue(v)
    ).length;
  }
  return n;
}

// ── saved responses ─────────────────────────────────────────────────────────

/** A Postman request body with content (redaction keeps only its `mode`). */
function hasPostmanBodyContent(body: unknown): boolean {
  if (!isObj(body)) return false;
  return Object.entries(body).some(
    ([k, v]) =>
      k !== 'mode' &&
      k !== 'options' &&
      (isNonEmptyScalar(v) || (Array.isArray(v) && v.length > 0) || isObj(v))
  );
}

/** A saved response's `originalRequest` (an object, or a bare URL string): all bag-only. */
function redactPostmanRequest(request: unknown): unknown {
  if (typeof request === 'string') return redactUrlCredentialsForStorage(request);
  if (!isObj(request)) return request;
  const next: Raw = { ...request };
  if (request.header !== undefined) next.header = redactPostmanHeaders(request.header);
  if (request.url !== undefined) next.url = redactPostmanUrl(request.url);
  if (isObj(request.auth)) next.auth = redactPostmanAuth(request.auth);
  // Request bodies can carry login payloads: keep only the mode.
  if (isObj(request.body)) next.body = { mode: request.body.mode };
  return next;
}

function countPostmanRequest(request: unknown): number {
  if (typeof request === 'string') return countUrlStringSecrets(request);
  if (!isObj(request)) return 0;
  return (
    countPostmanHeaders(request.header) +
    countPostmanUrl(request.url) +
    countPostmanAuthSecrets(request.auth, true) +
    (hasPostmanBodyContent(request.body) ? 1 : 0)
  );
}

function redactPostmanResponse(response: unknown): unknown {
  if (!isObj(response)) return response;
  const next: Raw = { ...response };
  if (response.header !== undefined) next.header = redactPostmanHeaders(response.header);
  if (typeof response.body === 'string') next.body = '';
  if (Array.isArray(response.cookie)) {
    next.cookie = response.cookie.map((c) => (isObj(c) ? { ...c, value: '' } : c));
  }
  if (response.originalRequest !== undefined) {
    next.originalRequest = redactPostmanRequest(response.originalRequest);
  }
  return next;
}

function countPostmanResponse(response: unknown): number {
  if (!isObj(response)) return 0;
  let n = countPostmanHeaders(response.header) + countPostmanRequest(response.originalRequest);
  // Saved-response bodies are blanked by redaction (they routinely hold
  // tokens / PII), so the export warning must see them too.
  if (typeof response.body === 'string' && response.body !== '') n += 1;
  if (Array.isArray(response.cookie)) {
    n += response.cookie.filter((c) => isObj(c) && isCredentialValue(c.value)).length;
  }
  return n;
}

// ── bag ─────────────────────────────────────────────────────────────────────

// ── v3 raw fields (#1200) ────────────────────────────────────────────────────
//
// v3 keeps some constructs as raw JSON (the importer scrubs them with this very
// walk, but a bag can be hand-edited or come from an older build): items with
// no Restura type, unmapped settings, protocol scripts, linked environments /
// schemas, Kafka leftovers and the shape of multi-entry auth. One walk both
// blanks and counts, so the export count always equals what redaction blanks:
//  - a field whose NAME is a credential has its whole value blanked (any type:
//    string, number, array, nested object), counted once;
//  - a `{ key|name, value }` row whose name is a credential (or that is
//    flagged secret) has its value blanked, counted once;
//  - URLs (a whole URL value, or URL substrings of free text such as a
//    script) lose userinfo and credential-named query values;
//  - prototype-polluting keys are dropped.
// A lone `{{var}}` reference is a pointer, not a secret, and is kept.

const V3_RAW_FIELDS = [
  'item',
  'settings',
  'scripts',
  'uses',
  'schema',
  'authSets',
  'event',
  'leftovers',
] as const;

/**
 * Structural fields: their value is a name / kind, never a credential
 * (`credentialKeys`: the key NAMES of a multi-auth set, values never kept).
 */
const V3_STRUCTURAL_FIELDS = new Set([
  'key',
  'name',
  'id',
  'type',
  '$kind',
  'description',
  'credentialKeys',
]);

/** Keys that must never be copied onto a fresh object (prototype pollution). */
export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function hasCredentialContent(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  if (typeof v === 'string' && SINGLE_VARIABLE_REFERENCE.test(v.trim())) return false;
  return isCredentialValue(v) && v !== false;
}

function rowName(row: Raw): string {
  if (typeof row.key === 'string') return row.key;
  return typeof row.name === 'string' ? row.name : '';
}

function isV3SecretRow(row: Raw, inCredentials: boolean): boolean {
  if (!('value' in row) || !hasCredentialContent(row.value)) return false;
  if (row.type === 'secret' || row.secret === true) return true;
  const name = rowName(row);
  if (name === '') return false;
  return inCredentials ? isPostmanAuthSecretKey(name) : isSecretFieldName(name);
}

/** A URL token inside free text (scripts, descriptions): stops at whitespace / quotes. */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi;

/**
 * URL credentials in a raw string. A whitespace-free value is one URL and is
 * redacted whole; free text (a script body, a description) only has its URL
 * substrings redacted, so a `?` in a ternary / optional chain is never read
 * as a query string.
 */
function walkV3String(value: string, counter: { n: number } | undefined): string {
  if (!/\s/.test(value)) {
    if (counter) counter.n += countUrlStringSecrets(value);
    return redactUrlCredentialsForStorage(value);
  }
  return value.replace(URL_IN_TEXT, (url) => {
    if (counter) counter.n += countUrlStringSecrets(url);
    return redactUrlCredentialsForStorage(url);
  });
}

function isV3SecretField(key: string, value: unknown): boolean {
  return !V3_STRUCTURAL_FIELDS.has(key) && isSecretFieldName(key) && hasCredentialContent(value);
}

/** Redact (`counter` undefined) or count (`counter.n`) credentials in a raw v3 value. */
function walkV3Raw(
  value: unknown,
  counter: { n: number } | undefined,
  depth = 0,
  inCredentials = false
): unknown {
  if (depth > MAX_COLLECTION_TREE_DEPTH) return null;
  if (typeof value === 'string' && value.includes('://')) return walkV3String(value, counter);
  if (Array.isArray(value)) {
    return value.map((v) => walkV3Raw(v, counter, depth + 1, inCredentials));
  }
  if (!isObj(value)) return value;
  const secretRow = isV3SecretRow(value, inCredentials);
  if (secretRow && counter) counter.n += 1;
  const next: Raw = {};
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(k)) continue;
    if (k === 'value' && secretRow) {
      next[k] = '';
    } else if (k !== 'value' && isV3SecretField(k, v)) {
      if (counter) counter.n += 1;
      next[k] = '';
    } else {
      next[k] = walkV3Raw(v, counter, depth + 1, k === 'credentials');
    }
  }
  return next;
}

/** Sanitised copy of a raw v3 value (the importer applies it before storing one). */
export function redactPostmanV3Raw(value: unknown): unknown {
  return walkV3Raw(value, undefined);
}

/** Credentials {@link redactPostmanV3Raw} would blank in `value`. */
export function countPostmanV3Raw(value: unknown): number {
  const counter = { n: 0 };
  walkV3Raw(value, counter);
  return counter.n;
}

function countV3RawFields(bag: Raw): number {
  let n = 0;
  for (const field of V3_RAW_FIELDS) {
    if (bag[field] !== undefined) n += countPostmanV3Raw(bag[field]);
  }
  return n;
}

/** Returns a sanitised copy of a `_postman` sidecar; shape and non-secret fields survive. */
export function redactPostmanBag(bag: unknown): unknown {
  if (!isObj(bag)) return bag;
  const next: Raw = { ...bag };
  if (isObj(bag.auth)) next.auth = redactPostmanAuth(bag.auth);
  if (bag.variable !== undefined) next.variable = redactPostmanRows(bag.variable);
  if (bag.urlVariable !== undefined) next.urlVariable = redactPostmanRows(bag.urlVariable);
  if (Array.isArray(bag.response)) next.response = bag.response.map(redactPostmanResponse);
  for (const field of V3_RAW_FIELDS) {
    if (bag[field] !== undefined) next[field] = walkV3Raw(bag[field], undefined);
  }
  return next;
}

/**
 * Plaintext secrets that live only in a `_postman` sidecar: exactly what
 * {@link redactPostmanBag} blanks, minus typed-model copies (counted there).
 */
export function countPostmanBagInlineSecrets(bag: unknown): number {
  if (!isObj(bag)) return 0;
  let n =
    // `authBagOnly`: the auth was NOT mapped onto the typed model (v3 broker
    // presets and placeholder items), so every credential lives only here.
    countPostmanAuthSecrets(bag.auth, bag.authBagOnly === true) +
    countPostmanRows(bag.variable) +
    countPostmanRows(bag.urlVariable) +
    countV3RawFields(bag);
  for (const response of Array.isArray(bag.response) ? bag.response : []) {
    n += countPostmanResponse(response);
  }
  return n;
}
