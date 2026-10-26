import { isSecretFieldName } from '../../secrets/key-value-redaction';
import { mapPostmanAuthParams, POSTMAN_MAPPED_AUTH_PARAMS, postmanAuthParamEntries } from './auth';

/**
 * Secret redaction / counting for the `_postman` sidecar (ADR 0034).
 *
 * The sidecar (`./sidecar.ts`) holds RAW Postman JSON for constructs Restura
 * cannot model: unsupported / approximated auth blocks, saved responses
 * (headers, cookies, bodies, original requests), item and URL variables.
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

export function isPostmanAuthSecretKey(key: string): boolean {
  return POSTMAN_AUTH_SECRET_KEYS.has(key) || isSecretFieldName(key);
}

/** Blank every credential param in EVERY block of an auth object (incl. inactive siblings). */
export function redactPostmanAuth(auth: Raw): Raw {
  const next: Raw = { ...auth };
  for (const [key, block] of Object.entries(auth)) {
    if (key === 'type') continue;
    next[key] = mapPostmanAuthParams(block, (p) => (isPostmanAuthSecretKey(p.key) ? '' : p.value));
  }
  return next;
}

/**
 * Plaintext credentials in a Postman auth block. `bagOnly` (saved-response
 * `originalRequest` auth) counts every credential. Otherwise, for typed
 * (mapped) types, keys the importer copies into the typed model are skipped
 * — they are counted there — so only bag-only material counts (e.g. an OAuth1
 * RSA `privateKey`).
 */
function countPostmanAuthSecrets(auth: unknown, bagOnly: boolean): number {
  if (!isObj(auth)) return 0;
  const type = typeof auth.type === 'string' ? auth.type : '';
  const mapped = bagOnly ? undefined : POSTMAN_MAPPED_AUTH_PARAMS[type];
  return postmanAuthParamEntries(auth[type]).filter(
    (p) => !mapped?.has(p.key) && isPostmanAuthSecretKey(p.key) && isNonEmptyScalar(p.value)
  ).length;
}

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

/** A Postman `{ key, value }` header / query / variable row holding a plaintext secret. */
function isPostmanSecretRow(row: unknown): boolean {
  if (!isObj(row) || !isNonEmptyScalar(row.value)) return false;
  if (row.type === 'secret' || row.secret === true) return true;
  if (typeof row.value === 'string' && SINGLE_VARIABLE_REFERENCE.test(row.value.trim())) {
    return false;
  }
  return typeof row.key === 'string' && isSecretFieldName(row.key);
}

function redactPostmanRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => (isPostmanSecretRow(row) ? { ...(row as object), value: '' } : row));
}

function countPostmanRows(rows: unknown): number {
  return Array.isArray(rows) ? rows.filter(isPostmanSecretRow).length : 0;
}

/** Saved responses + their `originalRequest`: everything here is bag-only. */
function redactPostmanRequest(request: unknown): unknown {
  if (!isObj(request)) return request;
  const next: Raw = { ...request, header: redactPostmanRows(request.header) };
  if (isObj(request.auth)) next.auth = redactPostmanAuth(request.auth);
  if (isObj(request.url)) {
    next.url = { ...request.url, query: redactPostmanRows(request.url.query) };
  }
  // Request bodies can carry login payloads: keep only the mode.
  if (isObj(request.body)) next.body = { mode: request.body.mode };
  return next;
}

function redactPostmanResponse(response: unknown): unknown {
  if (!isObj(response)) return response;
  const next: Raw = { ...response, header: redactPostmanRows(response.header) };
  if (typeof response.body === 'string') next.body = '';
  if (Array.isArray(response.cookie)) {
    next.cookie = response.cookie.map((c) => (isObj(c) ? { ...c, value: '' } : c));
  }
  if (response.originalRequest !== undefined) {
    next.originalRequest = redactPostmanRequest(response.originalRequest);
  }
  return next;
}

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

/** Plaintext secrets that live only in a `_postman` sidecar (see {@link redactPostmanBag}). */
export function countPostmanBagInlineSecrets(bag: unknown): number {
  if (!isObj(bag)) return 0;
  let n =
    countPostmanAuthSecrets(bag.auth, false) +
    countPostmanRows(bag.variable) +
    countPostmanRows(bag.urlVariable);
  for (const response of Array.isArray(bag.response) ? bag.response : []) {
    if (!isObj(response)) continue;
    n += countPostmanRows(response.header);
    // Saved-response bodies are blanked by redaction (they routinely hold
    // tokens / PII), so the export warning must see them too.
    if (isNonEmptyScalar(response.body)) n += 1;
    if (Array.isArray(response.cookie)) {
      n += response.cookie.filter((c) => isObj(c) && isNonEmptyScalar(c.value)).length;
    }
    const orig = response.originalRequest;
    if (isObj(orig)) {
      n += countPostmanRows(orig.header) + countPostmanAuthSecrets(orig.auth, true);
      if (hasPostmanBodyContent(orig.body)) n += 1;
      if (isObj(orig.url)) n += countPostmanRows(orig.url.query);
    }
  }
  return n;
}
