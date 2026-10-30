// Turn captured request traffic (history entries, saved collection requests)
// into eval dataset cases. Secrets are redacted with the SAME helpers the AI
// assistant uses before any request/response text reaches a model, plus known
// environment/secret values and URL scrubbing. Pure — the dialog supplies the
// raw history/collection items and the env values to strip.
import { redactBody, redactHeaders } from '@shared/protocol/ai/redaction';
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
export const MIN_ENV_VALUE_LENGTH = 8;

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

/** Replace every occurrence of a known env/secret value (longest first). */
function stripSecretValues(text: string, values: readonly string[] | undefined): string {
  if (!values?.length || !text) return text;
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    if (v.length >= MIN_ENV_VALUE_LENGTH) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

const TEMPLATE_ONLY = /^\{\{[^{}]+\}\}$/;
// A long mixed letter+digit segment is an opaque id/token, not a route word.
const OPAQUE_SEGMENT = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{20,}$/;

/** Scrub userinfo, fragment, query values and opaque path segments of a URL string. */
function scrubUrl(url: string): string {
  const noFragment = url.replace(/#.*$/, '');
  const [pathPart = '', ...queryRest] = noFragment.split('?');
  const path = pathPart
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1')
    .split('/')
    .map((seg) => (OPAQUE_SEGMENT.test(seg) ? '[REDACTED]' : seg))
    .join('/');
  if (queryRest.length === 0) return path;
  const query = queryRest
    .join('?')
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      return TEMPLATE_ONLY.test(pair.slice(eq + 1)) ? pair : `${pair.slice(0, eq + 1)}[REDACTED]`;
    })
    .join('&');
  return `${path}?${query}`;
}

const redactText = (text: string, o: RedactionOptions): string =>
  stripSecretValues(redactBody(text, 'default'), o.secretValues);

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
    headers[k] = stripSecretValues(v, o.secretValues);
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
