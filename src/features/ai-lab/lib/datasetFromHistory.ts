// Turn captured request traffic (history entries, saved collection requests)
// into eval dataset cases. Secrets are redacted with the SAME helpers the AI
// assistant uses before any request/response text reaches a model, plus known
// environment/secret values and URL scrubbing. Pure — the dialog supplies the
// raw history/collection items and the env values to strip.
import {
  MIN_SECRET_LITERAL_LENGTH,
  redactBody,
  redactHeaders,
} from '@shared/protocol/ai/redaction';
import type { KeyValue } from '@/types/common';
import type { HttpRequest, Response as HttpResponse } from '@/types/http';
import type { DatasetCase } from '../types';

/** A request paired with its (optional) captured response. */
export interface CapturedRequest {
  request: HttpRequest;
  response?: HttpResponse;
}

export interface RedactionOptions {
  /** Known environment/global variable values to strip wherever they appear. */
  secretValues?: readonly string[];
}

/** Short structural values ("8080", "v2") are not secrets; mirrors the assistant prompt builder. */
export const MIN_ENV_VALUE_LENGTH = MIN_SECRET_LITERAL_LENGTH;

function headersToRecord(headers: KeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.enabled !== false && h.key) out[h.key] = h.value;
  }
  return out;
}

/** Best-effort textual request body (raw bodies only; binary/files skipped). */
function requestBodyText(req: HttpRequest): string {
  const b = req.body;
  if (!b || b.type === 'none') return '';
  if (typeof b.raw === 'string') return b.raw;
  return '';
}

function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The forms a value takes once it is embedded in a URL, a header or a JSON body. */
function secretVariants(value: string): string[] {
  const b64 = base64Utf8(value);
  let urlEncoded = value;
  try {
    urlEncoded = encodeURIComponent(value);
  } catch {
    // A lone surrogate is not encodable; the raw and other forms still apply.
  }
  return [
    ...new Set([
      value,
      urlEncoded,
      b64,
      b64.replace(/=+$/, ''),
      JSON.stringify(value).slice(1, -1),
    ]),
  ].filter((v) => v.length >= MIN_ENV_VALUE_LENGTH);
}

/** Replace every occurrence of a known env/secret value, and its encoded forms (longest first). */
function stripSecretValues(text: string, values: readonly string[] | undefined): string {
  if (!values?.length || !text) return text;
  let out = text;
  const variants = values
    .filter((v) => v.length >= MIN_ENV_VALUE_LENGTH)
    .flatMap(secretVariants)
    .sort((a, b) => b.length - a.length);
  for (const v of variants) out = out.split(v).join('[REDACTED]');
  return out;
}

/**
 * Values to strip from the variables of every scope (environments, globals,
 * collection and folder variables). Disabled variables are included on
 * purpose: a history entry may predate the toggle, and over-stripping is harmless.
 */
export function secretValuesFromScopes(
  scopes: ReadonlyArray<ReadonlyArray<{ value: string }> | undefined>
): string[] {
  const values = new Set<string>();
  for (const scope of scopes) for (const v of scope ?? []) if (v.value) values.add(v.value);
  return [...values];
}

const TEMPLATE_ONLY = /^\{\{[^{}]+\}\}$/;
// A long mixed letter+digit segment is an opaque id/token, not a route word.
const OPAQUE_SEGMENT = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{20,}$/;

// Optional scheme (known web schemes may be followed by anything, others only by a
// slash so `user:pw@host` is not mistaken for a scheme; `{{var}}` may stand in for
// one), then any run of `/` or `\`.
const URL_PREFIX =
  /^(?:(?:https?|wss?|ftps?):|(?:[a-z][a-z0-9+.-]*|\{\{[^{}]+\}\}):(?=[\\/]))?[\\/]*/i;

/** Remove `userinfo@` from the text after the scheme prefix. */
function stripUserinfo(rest: string): string {
  // Standard rule: the authority ends at the first `/ \ ? #`; userinfo ends at its last `@`.
  const authorityEnd = rest.search(/[/\\?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at >= 0) return rest.slice(at + 1);
  // Lenient rule for passwords holding `/ ? #`: `u:pa/ss@host`. Only when a `:`
  // opens before any delimiter and what follows it is not a bare port, so
  // `host:8080/users/@me` and `?e=a:b@c` are left alone.
  const lastAt = rest.lastIndexOf('@');
  if (lastAt < 0) return rest;
  const candidate = rest.slice(0, lastAt);
  const delimiter = candidate.search(/[/\\?#]/);
  const head = delimiter < 0 ? candidate : candidate.slice(0, delimiter);
  const colon = head.indexOf(':');
  if (colon < 0 || /^\d*$/.test(head.slice(colon + 1))) return rest;
  return rest.slice(lastAt + 1);
}

/**
 * Scrub userinfo, fragment, query values and opaque path segments of a URL
 * string. Done on the raw string rather than via `new URL(...).toString()`,
 * which would percent-encode `{{templates}}` and rejects the scheme-less and
 * malformed shapes history can hold.
 */
function scrubUrl(url: string): string {
  const prefix = URL_PREFIX.exec(url)?.[0] ?? '';
  const withoutUserinfo = stripUserinfo(url.slice(prefix.length));
  const hash = withoutUserinfo.indexOf('#');
  const noFragment = hash < 0 ? withoutUserinfo : withoutUserinfo.slice(0, hash);
  const qIndex = noFragment.indexOf('?');
  const pathPart = qIndex < 0 ? noFragment : noFragment.slice(0, qIndex);
  const queryPart = qIndex < 0 ? null : noFragment.slice(qIndex + 1);
  const path =
    prefix +
    pathPart
      .split('/')
      .map((seg) => (OPAQUE_SEGMENT.test(seg) ? '[REDACTED]' : seg))
      .join('/');
  if (queryPart === null) return path;
  const query = queryPart
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      // A bare `?token` has no key to keep: the whole pair may be the secret.
      if (eq < 0) return pair === '' || TEMPLATE_ONLY.test(pair) ? pair : '[REDACTED]';
      return TEMPLATE_ONLY.test(pair.slice(eq + 1)) ? pair : `${pair.slice(0, eq + 1)}[REDACTED]`;
    })
    .join('&');
  return `${path}?${query}`;
}

// Known literals go first: a pattern such as `Bearer <token>` stops at the first
// character outside its class and would leave the tail of a literal behind.
const redactText = (text: string, o: RedactionOptions): string =>
  redactBody(stripSecretValues(text, o.secretValues), 'default');

/** Case vars for a request; `o === null` keeps everything raw (diff baseline only). */
function buildVars(item: CapturedRequest, o: RedactionOptions | null): Record<string, string> {
  const rawHeaders = headersToRecord(item.request.headers);
  const rawBody = requestBodyText(item.request);
  if (!o) {
    return {
      method: item.request.method,
      url: item.request.url,
      headers: JSON.stringify(rawHeaders),
      body: rawBody,
    };
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(redactHeaders(rawHeaders, 'default'))) {
    // Names are denylisted by redactHeaders; values still get the token patterns.
    headers[k] = redactText(v, o);
  }
  return {
    method: item.request.method,
    url: scrubUrl(redactText(item.request.url, o)),
    headers: JSON.stringify(headers),
    body: redactText(rawBody, o),
  };
}

/**
 * Map one captured request into a dataset case. The request fields become
 * `vars` (so a prompt template can reference `{{method}}`, `{{url}}`, …) and the
 * captured response body becomes the `reference`. All secret-bearing text is
 * redacted first: credential headers, token patterns, known env/secret values,
 * and the URL's userinfo/query values/opaque path segments.
 */
export function capturedRequestToCase(
  item: CapturedRequest,
  options: RedactionOptions = {}
): Omit<DatasetCase, 'id'> {
  const out: Omit<DatasetCase, 'id'> = { vars: buildVars(item, options) };
  if (item.response) {
    return { ...out, reference: redactText(item.response.body ?? '', options) };
  }
  return out;
}

/** Map a list of captured requests into cases. */
export function capturedRequestsToCases(
  items: CapturedRequest[],
  options: RedactionOptions = {}
): Array<Omit<DatasetCase, 'id'>> {
  return items.map((i) => capturedRequestToCase(i, options));
}

export interface RedactionChange {
  field: 'url' | 'headers' | 'body' | 'response';
  before: string;
  after: string;
}

/** Fields the import would change, for the pre-save redaction diff preview. */
export function previewRedactions(
  item: CapturedRequest,
  options: RedactionOptions = {}
): RedactionChange[] {
  const before = buildVars(item, null);
  const after = capturedRequestToCase(item, options);
  const pairs: RedactionChange[] = [
    { field: 'url', before: before.url ?? '', after: after.vars.url ?? '' },
    { field: 'headers', before: before.headers ?? '', after: after.vars.headers ?? '' },
    { field: 'body', before: before.body ?? '', after: after.vars.body ?? '' },
  ];
  if (item.response) {
    pairs.push({
      field: 'response',
      before: item.response.body ?? '',
      after: after.reference ?? '',
    });
  }
  return pairs.filter((p) => p.before !== p.after);
}
