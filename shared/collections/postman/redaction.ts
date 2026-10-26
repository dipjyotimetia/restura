import { isSecretFieldName } from '../../secrets/key-value-redaction';
import { isSecretHandle, type SecretValue } from '../../secrets/secret-ref';
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

/** Returns a sanitised copy of a `_postman` sidecar; shape and non-secret fields survive. */
export function redactPostmanBag(bag: unknown): unknown {
  if (!isObj(bag)) return bag;
  const next: Raw = { ...bag };
  if (isObj(bag.auth)) next.auth = redactPostmanAuth(bag.auth);
  if (bag.variable !== undefined) next.variable = redactPostmanRows(bag.variable);
  if (bag.urlVariable !== undefined) next.urlVariable = redactPostmanRows(bag.urlVariable);
  if (Array.isArray(bag.response)) next.response = bag.response.map(redactPostmanResponse);
  return next;
}

/**
 * Plaintext secrets that live only in a `_postman` sidecar: exactly what
 * {@link redactPostmanBag} blanks, minus typed-model copies (counted there).
 */
export function countPostmanBagInlineSecrets(bag: unknown): number {
  if (!isObj(bag)) return 0;
  let n =
    countPostmanAuthSecrets(bag.auth, false) +
    countPostmanRows(bag.variable) +
    countPostmanRows(bag.urlVariable);
  for (const response of Array.isArray(bag.response) ? bag.response : []) {
    n += countPostmanResponse(response);
  }
  return n;
}
