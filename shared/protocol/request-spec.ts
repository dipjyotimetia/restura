/**
 * The host-independent step before `executeHttpProxy`: which rows are sent, how a
 * stored body maps to the proxy's body, and the header-or-query credential for
 * bearer, basic, api-key and oauth2. The renderer and the CLI both build their
 * proxy spec from here, so the two cannot drift.
 *
 * Hosts inject variable resolution and Secret access. Everything else a host does
 * stays with the host: file reading, keychain work, and acting on
 * `requiresMainSideApply`. Sign-at-wire schemes (AWS SigV4, OAuth1, WSSE, Digest,
 * NTLM) produce no credential here; their descriptor travels to the proxy, which
 * signs the exact bytes it sends (ADR-0007, ADR-0016).
 */

import type { SecretValue } from '../secrets/secret-ref';
import type { AuthConfig, BodyType, FormDataItem, RequestBody } from '../types';
import { scanVariableTokens } from '../variables/tokens';
import type { FormField, ProxyBodyType } from './body-builder';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One rule for headers, params and form rows: `enabled` truthy, and a key. */
export function isSendableRow(row: { enabled?: boolean; key?: string }): boolean {
  return Boolean(row.enabled && row.key);
}

/**
 * Sendable key/value rows as a map; the host supplies each row's final value.
 * A repeated key keeps only its last value — use {@link collectEnabledRowPairs}
 * for query params and {@link collectEnabledHeaders} for headers, which keep
 * every row.
 */
export function collectEnabledRows<T extends { enabled?: boolean; key: string }>(
  rows: readonly T[],
  getValue: (row: T) => string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (isSendableRow(row)) out[row.key] = getValue(row);
  }
  return out;
}

/** Sendable rows as ordered `[key, value]` pairs: repeated keys all survive, in order. */
export function collectEnabledRowPairs<T extends { enabled?: boolean; key: string }>(
  rows: readonly T[],
  getValue: (row: T) => string
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const row of rows) {
    if (isSendableRow(row)) out.push([row.key, getValue(row)]);
  }
  return out;
}

/**
 * Merge auth-produced headers into `headers` IN PLACE: each one replaces every
 * existing header of the same name in any casing, so the wire carries exactly
 * one (a user `authorization` row next to the auth tab's `Authorization` would
 * otherwise go out as two, which fetch joins into `a, b`). One rule for every
 * host and scheme — Bearer / Basic / API key / OAuth2 and the sign-at-wire
 * SigV4 (`x-amz-*`) / OAuth1 / WSSE headers. Returns `headers`.
 */
export function mergeAuthHeaders(
  headers: Record<string, string>,
  authHeaders: Record<string, string>
): Record<string, string> {
  const replaced = new Set(Object.keys(authHeaders).map((k) => k.toLowerCase()));
  if (replaced.size === 0) return headers;
  for (const name of Object.keys(headers)) {
    if (replaced.has(name.toLowerCase())) delete headers[name];
  }
  return Object.assign(headers, authHeaders);
}

/**
 * Sendable header rows as a map. Names match case-insensitively (the first
 * row's spelling is kept) and repeated rows are combined rather than the last
 * one winning: `Cookie` with `"; "` (RFC 6265 §5.4), everything else with
 * `", "` (RFC 9110 §5.3).
 */
export function collectEnabledHeaders<T extends { enabled?: boolean; key: string }>(
  rows: readonly T[],
  getValue: (row: T) => string
): Record<string, string> {
  const out: Record<string, string> = {};
  const nameFor = new Map<string, string>();
  for (const row of rows) {
    if (!isSendableRow(row)) continue;
    const value = getValue(row);
    const lower = row.key.toLowerCase();
    const existing = nameFor.get(lower);
    if (existing === undefined) {
      nameFor.set(lower, row.key);
      out[row.key] = value;
      continue;
    }
    const joiner = lower === 'cookie' ? '; ' : ', ';
    const prior = out[existing] ?? '';
    out[existing] = prior === '' ? value : value === '' ? prior : `${prior}${joiner}${value}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

/**
 * Escape a query key or value as little as possible: only what would change
 * how the query re-parses (`&`, `#`, and `=` in a key) and a `%` that does not
 * start an escape. `+`, `:`, `,`, `/`, `@`, `?` and existing `%XX` escapes go
 * out as typed (Postman behaviour). What WHATWG URL serialization still must
 * escape (space, quotes, `<`, `>`, non-ASCII) is left to the proxy's `new URL()`,
 * which encodes space as `%20` — never `+`. `{` and `}` are escaped too: they
 * are not valid in a query (RFC 3986) and WHATWG URL leaves them raw, so an
 * unresolved `{{var}}` goes out as `%7B%7Bvar%7D%7D`, as Newman sends it.
 */
export function encodeQueryComponent(text: string, isKey: boolean): string {
  const out = text
    .replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
    .replace(/&/g, '%26')
    .replace(/#/g, '%23')
    .replace(/\{/g, '%7B')
    .replace(/\}/g, '%7D');
  return isKey ? out.replace(/=/g, '%3D') : out;
}

/**
 * Marks a query row Restura built itself (GraphQL GET `query` / `variables` /
 * …), as opposed to one a user typed. Its key and value are opaque data, so
 * they go out fully percent-encoded (`encodeURIComponent`): the minimal
 * "as typed" escaping would let WHATWG URL parsing strip TAB/LF/CR and leave
 * `+` (read as space) and `%XX` (decoded) in the document.
 */
export interface BuiltQueryRow {
  encodeFully: true;
}

export function isBuiltQueryRow(row: object): row is BuiltQueryRow {
  return (row as Partial<BuiltQueryRow>).encodeFully === true;
}

/** An ordered query pair; a third element `true` marks opaque (fully encoded) data. */
export type QueryPair = readonly [key: string, value: string, encodeFully?: boolean];

/**
 * Sendable query rows as ordered pairs (repeated keys kept), each flagged when
 * it is a {@link BuiltQueryRow}.
 */
export function collectQueryPairs<T extends { enabled?: boolean; key: string }>(
  rows: readonly T[],
  getValue: (row: T) => string
): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = [];
  for (const row of rows) {
    if (isSendableRow(row)) out.push([row.key, getValue(row), isBuiltQueryRow(row)]);
  }
  return out;
}

/**
 * Append ordered query pairs to `url` (before any `#fragment`). With
 * `encode: false` (the request's "encode URL automatically" turned off) the
 * pairs go out exactly as written. A pair flagged `encodeFully` is always
 * fully percent-encoded — it is data Restura built, not text a user typed.
 */
export function appendQueryPairs(
  url: string,
  pairs: ReadonlyArray<QueryPair>,
  options: { encode?: boolean } = {}
): string {
  if (pairs.length === 0) return url;
  const encode = options.encode !== false;
  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? '' : url.slice(hash);
  const tail = pairs
    .map(([k, v, full]) =>
      full
        ? `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
        : encode
          ? `${encodeQueryComponent(k, true)}=${encodeQueryComponent(v, false)}`
          : `${k}=${v}`
    )
    .join('&');
  const joiner = !base.includes('?') ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
  return `${base}${joiner}${tail}${fragment}`;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/**
 * The stored body type is wider than the proxy's. Types the proxy has no name for
 * travel as `raw` so a user-supplied Content-Type is preserved verbatim.
 */
export function mapProxyBodyType(type: BodyType): ProxyBodyType {
  switch (type) {
    case 'none':
    case 'json':
    case 'text':
    case 'form-data':
    case 'binary':
      return type;
    case 'x-www-form-urlencoded':
      return 'form-urlencoded';
    case 'graphql':
      return 'json';
    case 'xml':
    case 'protobuf':
    case 'multipart-mixed':
      return 'raw';
    default: {
      const exhaustive: never = type;
      throw new Error(`Unmapped body type: ${exhaustive as string}`);
    }
  }
}

export interface FormFieldHooks {
  /** Applied to a text row's value. File rows hold base64 bytes and are never touched. */
  resolveValue?: (text: string) => string;
  /** Applied to every sent row's name, when the host resolves names. */
  resolveName?: (text: string) => string;
}

/**
 * Sendable rows as the proxy's fields. Hooks run only on rows that are sent, so a
 * disabled row can neither trip host policy nor spend a dynamic.
 */
export function buildProxyFormFields(
  items: readonly FormDataItem[] | undefined,
  hooks: FormFieldHooks = {}
): FormField[] {
  const out: FormField[] = [];
  for (const item of items ?? []) {
    if (!isSendableRow(item)) continue;
    const name = hooks.resolveName ? hooks.resolveName(item.key) : item.key;
    out.push(
      item.type === 'file'
        ? {
            name,
            value: item.value,
            filename: item.fileName ?? 'file',
            contentType: item.contentType ?? 'application/octet-stream',
          }
        : { name, value: hooks.resolveValue ? hooks.resolveValue(item.value) : item.value }
    );
  }
  return out;
}

export interface ProxyBody {
  bodyType: ProxyBodyType;
  data?: string;
  formData?: FormField[];
}

export interface ProxyBodyHooks {
  /** Resolves `{{vars}}` in raw text and in text form values. Called once per text. */
  resolve: (text: string) => string;
  /** See {@link FormFieldHooks.resolveName}. */
  resolveFieldName?: (text: string) => string;
  /** A binary body is base64 bytes and stays verbatim unless the host resolves it. */
  resolveBinary?: (text: string) => string;
}

/**
 * The proxy body for a stored body. Multipart carries only its structured fields.
 * Urlencoded prefers its fields (imported collections store them that way) and
 * falls back to raw; a file row can't be urlencoded, so it is dropped.
 */
export function buildProxyBody(body: RequestBody | undefined, hooks: ProxyBodyHooks): ProxyBody {
  if (!body) return { bodyType: 'none' };
  const bodyType = mapProxyBodyType(body.type);
  if (bodyType === 'none') return { bodyType };

  if (bodyType === 'form-data' || bodyType === 'form-urlencoded') {
    const rows =
      bodyType === 'form-urlencoded'
        ? body.formData?.filter((item) => item.type !== 'file')
        : body.formData;
    const formData = buildProxyFormFields(rows, {
      resolveValue: hooks.resolve,
      ...(hooks.resolveFieldName ? { resolveName: hooks.resolveFieldName } : {}),
    });
    if (formData.length > 0) return { bodyType, formData };
    if (bodyType === 'form-data') return { bodyType };
  }

  if (body.raw === undefined) return { bodyType };
  if (bodyType === 'binary') {
    return { bodyType, data: hooks.resolveBinary ? hooks.resolveBinary(body.raw) : body.raw };
  }
  return { bodyType, data: hooks.resolve(body.raw) };
}

/**
 * Headers a body type implies. XML travels as `raw`, which sets no Content-Type of
 * its own, so it gets a default unless the request sets one in any casing.
 */
export function applyBodyDefaultHeaders(
  type: BodyType | undefined,
  headers: Record<string, string>
): Record<string, string> {
  if (type === 'xml' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/xml';
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/** Returned by a host that can't read this secret but can hand it on by reference. */
export const DEFERRED_SECRET: unique symbol = Symbol('deferred-secret');

export interface CredentialHost {
  /**
   * Plaintext for a secret; undefined when absent; {@link DEFERRED_SECRET} when
   * another process will apply it. A host that can do neither throws.
   */
  readSecret: (value: SecretValue | undefined) => string | undefined | typeof DEFERRED_SECRET;
  /**
   * Base64 for `username:password`. Injected because the hosts differ on text
   * outside Latin-1: the browser's `btoa` throws, Node encodes UTF-8.
   */
  encodeBasic: (credentials: string) => string;
}

export interface AuthCredential {
  /** Header name to value. For HTTP these become request headers; for gRPC, metadata. */
  headers: Record<string, string>;
  /** Query params (only populated for `api-key` with `in: 'query'`). */
  params: Record<string, string>;
  /** A secret was deferred: no credential was built, the host must apply it elsewhere. */
  requiresMainSideApply?: boolean;
}

export interface AuthCredentialOptions {
  /**
   * `'preserve'` keeps user-supplied casing on auth headers (HTTP convention,
   * matches what Postman/Insomnia send). `'lower'` lowercases the standard
   * `authorization` header and any api-key header, as gRPC metadata requires.
   */
  headerCase?: 'preserve' | 'lower';
  /**
   * If true, Basic requires BOTH username AND password. Defaults to false (HTTP
   * semantics: RFC 7617 permits an empty password and several APIs use the
   * username slot for an opaque token). Outside this mode an empty username with
   * a password is sent as `:password` (the `:token` shape); a Basic credential
   * with neither is never sent. In this mode a username is required too.
   */
  basicRequiresPassword?: boolean;
}

/** Headers this auth puts on the request under a name of the user's choosing. */
export function authHeaderNames(auth: AuthConfig | undefined): string[] {
  if (auth?.type !== 'api-key' || auth.apiKey?.in === 'query' || !auth.apiKey?.key) return [];
  return [auth.apiKey.key];
}

export function buildAuthCredential(
  auth: AuthConfig | undefined,
  host: CredentialHost,
  options: AuthCredentialOptions = {}
): AuthCredential {
  const empty: AuthCredential = { headers: {}, params: {} };
  const deferred: AuthCredential = { ...empty, requiresMainSideApply: true };
  if (!auth || auth.type === 'none') return empty;

  const lower = options.headerCase === 'lower';
  const authzKey = lower ? 'authorization' : 'Authorization';

  switch (auth.type) {
    case 'bearer': {
      const token = host.readSecret(auth.bearer?.token);
      if (token === DEFERRED_SECRET) return deferred;
      if (!token) return empty;
      return { headers: { [authzKey]: `Bearer ${token}` }, params: {} };
    }

    case 'basic': {
      const password = host.readSecret(auth.basic?.password);
      if (password === DEFERRED_SECRET) return deferred;
      const username = auth.basic?.username ?? '';
      if (options.basicRequiresPassword ? !username || !password : !username && !password) {
        return empty;
      }
      const encoded = host.encodeBasic(`${username}:${password ?? ''}`);
      return { headers: { [authzKey]: `Basic ${encoded}` }, params: {} };
    }

    case 'api-key': {
      const value = host.readSecret(auth.apiKey?.value);
      if (value === DEFERRED_SECRET) return deferred;
      const key = auth.apiKey?.key ?? '';
      if (!key || !value) return empty;
      if (auth.apiKey?.in === 'query') return { headers: {}, params: { [key]: value } };
      return { headers: { [lower ? key.toLowerCase() : key]: value }, params: {} };
    }

    case 'oauth2': {
      const token = host.readSecret(auth.oauth2?.accessToken);
      if (token === DEFERRED_SECRET) return deferred;
      if (!token) return empty;
      const tokenType = auth.oauth2?.tokenType || 'Bearer';
      const authorization = `${tokenType} ${token}`;
      // A token written in either field stays as written; one that spans the join
      // was never written anywhere, so it must not reach a later resolver.
      const join = tokenType.length;
      if (scanVariableTokens(authorization).some(({ start, end }) => start <= join && end > join)) {
        throw new Error(
          'The OAuth 2.0 token type and access token form a variable reference, so the request was not sent.'
        );
      }
      return { headers: { [authzKey]: authorization }, params: {} };
    }

    // Sign-at-wire types: the caller forwards the descriptor (digest answers a
    // challenge, oauth1/aws-signature need body and URL bytes, ntlm is
    // desktop-only, wsse is signed in the proxy).
    default:
      return empty;
  }
}
