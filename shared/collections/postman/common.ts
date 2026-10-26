import { v4 as uuid } from 'uuid';
import { isConfiguredAuth } from '../../auth/inheritance';
import { checkHttpMethod } from '../../protocol/http-method';
import type { AuthConfig, HttpMethod, KeyValue } from '../../types';
import { activeAuthBlock, authParamsV2, convertPostmanAuth, unmappedAuthRemainder } from './auth';
import type { PostmanReportBuilder } from './report';
import type { PostmanSidecar } from './sidecar';

/**
 * Helpers shared by the Postman version front ends (`parse-v2.ts`,
 * `parse-v3.ts`). Input is untrusted, so everything reads from `unknown`.
 */

export interface ParseContext {
  report: PostmanReportBuilder;
  transformScript: (script: string) => string;
}

export type Raw = Record<string, unknown>;

export function isObj(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export function description(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined;
  if (isObj(v) && typeof v.content === 'string') return v.content;
  return undefined;
}

export function keyValue(row: Raw): KeyValue {
  return {
    id: uuid(),
    key: str(row.key),
    value: str(row.value),
    enabled: row.disabled !== true,
    description: description(row.description),
  };
}

/**
 * Maximum folder nesting accepted on import. Real collections are a handful of
 * levels deep; the cap turns a hostile/garbage deeply nested document into a
 * clear import error instead of unbounded recursion here and in every
 * recursive consumer downstream (store, redaction, runner).
 */
export const MAX_POSTMAN_NESTING_DEPTH = 64;

export interface AuthOutcome {
  /** undefined → inherit from the parent. */
  auth: AuthConfig | undefined;
  /**
   * Raw auth to keep in the sidecar (unsupported / approximated). For typed
   * (approximated) types only the UNMAPPED keys are kept — mapped credentials
   * live on the typed model and must not be duplicated (ADR-0007).
   */
  sidecarAuth?: Raw;
  /**
   * Set when the Postman auth type is unsupported (imported as `none`). The
   * node's inheriting descendants must then get an explicit `none` too, never
   * an ancestor's credentials (see {@link inheritAuth}).
   */
  unsupported?: string;
}

/**
 * What a child inherits from its parent: the nearest configured auth, or the
 * type of the nearest UNSUPPORTED auth that cut the chain (Postman would sign
 * with that type; Restura must not substitute a credential from further up).
 */
export interface InheritedPostmanAuth {
  auth?: AuthConfig;
  unsupported?: string;
}

/** The inheritance a container (collection / folder) hands its children. */
export function inheritFrom(
  outcome: AuthOutcome,
  parent: InheritedPostmanAuth
): InheritedPostmanAuth {
  if (outcome.unsupported) return { unsupported: outcome.unsupported };
  if (isConfiguredAuth(outcome.auth)) return { auth: outcome.auth };
  return parent;
}

/**
 * Auth for a request that inherits (`auth` / `inherit` absent on it): the
 * nearest ancestor's, or an explicit `none` plus a report entry naming the
 * request when an unsupported ancestor auth cut the chain.
 */
export function inheritAuth(
  inherited: InheritedPostmanAuth,
  requestName: string,
  ctx: ParseContext
): AuthConfig | undefined {
  if (inherited.unsupported) {
    ctx.report.unsupportedAuth(inherited.unsupported, requestName);
    return { type: 'none' };
  }
  return inherited.auth;
}

/**
 * Map a v2-shaped Postman auth block (`{ type, [type]: params }`), reporting
 * losses. v3 callers convert `{ type, credentials }` into this shape first so
 * every sidecar auth bag has the one shape the redactor and the SecretRef
 * migration understand.
 */
export function convertAuthBlock(raw: Raw, ownerName: string, ctx: ParseContext): AuthOutcome {
  // Own-property lookup only: `type` is untrusted (`__proto__`, `constructor`).
  const { type, block } = activeAuthBlock(raw);
  const result = convertPostmanAuth(type, authParamsV2(block));
  switch (result.status) {
    case 'inherit':
      return { auth: undefined };
    case 'ok':
      return { auth: result.auth };
    case 'approximated':
      ctx.report.unmodelled(result.construct, ownerName);
      return { auth: result.auth, sidecarAuth: unmappedAuthRemainder(raw) };
    case 'unsupported':
      ctx.report.unsupportedAuth(result.authType, ownerName);
      return {
        auth: result.auth,
        sidecarAuth: unmappedAuthRemainder(raw),
        unsupported: result.authType,
      };
  }
}

export function parseQueryString(qs: string): KeyValue[] {
  if (!qs) return [];
  return qs
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=');
      return keyValue({
        key: eq === -1 ? part : part.slice(0, eq),
        value: eq === -1 ? '' : part.slice(eq + 1),
      });
    });
}

/**
 * Split a full URL into the base (fragment kept) and its query rows. Restura
 * keeps the query in the params table only — leaving it in the URL too would
 * send every param twice. `explicit` (a structured query table) wins over the
 * URL text. `transformBase` rewrites the path part (e.g. `:name` substitution).
 */
export function splitUrlQuery(
  full: string,
  explicit?: KeyValue[],
  transformBase: (base: string) => string = (b) => b
): { url: string; params: KeyValue[] } {
  const hash = full.indexOf('#');
  const fragment = hash === -1 ? '' : full.slice(hash);
  const beforeFragment = hash === -1 ? full : full.slice(0, hash);
  const q = beforeFragment.indexOf('?');
  const base = transformBase(q === -1 ? beforeFragment : beforeFragment.slice(0, q));
  const params = explicit ?? parseQueryString(q === -1 ? '' : beforeFragment.slice(q + 1));
  return { url: base + fragment, params };
}

export function coerceMethod(
  raw: unknown,
  requestName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): HttpMethod {
  // The former SDK upper-cased every method on parse; keep that behaviour.
  const upper = (typeof raw === 'string' && raw.trim() ? raw : 'GET').trim().toUpperCase();
  const check = checkHttpMethod(upper);
  if (check.ok) return check.method;
  ctx.report.unsupportedMethod(upper, requestName);
  sidecar.method = raw;
  return 'GET';
}

/** A whole `:name` path segment (never a port like `host:8080` or a `{{var}}`). */
const PATH_VARIABLE_SEGMENT = /^:([A-Za-z_][\w.-]*)$/;

/**
 * Substitute `:name` path segments from Postman's `url.variable` list, as the
 * former SDK's `Url.toString()` did — Restura has no `:param` runtime, so a
 * literal `:id` would go on the wire. Only whole segments are replaced, and
 * only by a non-empty value. Entries that cannot be resolved (empty value, no
 * matching segment) or that carry a description (lost in the typed model)
 * are reported, and the whole list is kept in the sidecar.
 */
export function substitutePathVariables(
  base: string,
  variables: unknown[],
  requestName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): string {
  const values = new Map<string, string>();
  let lossy = false;
  for (const v of variables) {
    if (!isObj(v) || typeof v.key !== 'string') {
      lossy = true;
      continue;
    }
    const value = str(v.value);
    if (value !== '') values.set(v.key, value);
    else lossy = true;
    if (description(v.description) !== undefined) lossy = true;
  }
  const used = new Set<string>();
  const out = base
    .split('/')
    .map((segment) => {
      const name = PATH_VARIABLE_SEGMENT.exec(segment)?.[1];
      const value = name === undefined ? undefined : values.get(name);
      if (name === undefined || value === undefined) return segment;
      used.add(name);
      return value;
    })
    .join('/');
  if ([...values.keys()].some((k) => !used.has(k))) lossy = true;
  if (lossy) {
    sidecar.urlVariable = variables;
    ctx.report.unmodelled('path-variables', requestName);
  }
  return out;
}
