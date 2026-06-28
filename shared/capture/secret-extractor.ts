/**
 * Secret-safe redaction for captured exchanges.
 *
 * Runs BEFORE anything is persisted, exported, or sent over the desktop bridge.
 * Denied header values are replaced with `{{name}}` placeholders and the matched
 * secrets are reported so a consumer can materialize them as SecretRef-backed
 * environment variables. Body token patterns are masked in place.
 *
 * Pattern coverage mirrors `shared/protocol/ai/redaction.ts` (header denylist +
 * JWT / Bearer / `key=val` / prefixed provider tokens). The header-name base set
 * is imported from the shared constant; the body regexes are duplicated because
 * `redaction.ts` does not export them.
 */
import { CREDENTIAL_HEADER_NAMES } from '../protocol/credential-header-names';
import type { CapturedBody, CapturedExchange, CapturedHeader } from './types';

const HEADER_DENYLIST_EXACT = new Set(CREDENTIAL_HEADER_NAMES);
const HEADER_DENYLIST_REGEX: RegExp[] = [
  /^x-.*-token$/i,
  /^x-.*-key$/i,
  /^x-.*-secret$/i,
  /^api[-_]?key$/i,
];

const BODY_TOKEN_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g,
  /(api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}/gi,
  /\bsk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];

const MASK = '«redacted»';

export interface RedactedSecret {
  /** Variable name a consumer should create (also used inside `{{…}}`). */
  name: string;
  placeholder: string;
}

export interface RedactionResult {
  exchange: CapturedExchange;
  secrets: RedactedSecret[];
}

function headerIsDenied(name: string): boolean {
  const lower = name.toLowerCase();
  if (HEADER_DENYLIST_EXACT.has(lower)) return true;
  return HEADER_DENYLIST_REGEX.some((re) => re.test(lower));
}

// Credential-bearing query-param names. Broader than the header denylist because
// secrets in URLs use different conventions (?access_token=, ?sig=, OAuth ?code=,
// presigned ?X-Amz-Signature=).
const QUERY_PARAM_DENYLIST: RegExp[] = [
  /^(access|refresh|id)?[-_]?token$/i,
  // (api[-_]?key is already covered by headerIsDenied, checked first.)
  /^(client[-_]?)?secret$/i,
  /^(password|passwd|pwd)$/i,
  /^(sig|signature)$/i,
  /^code$/i,
  /^(auth|session|sessionid|sid)$/i,
  /^x-amz-(signature|security-token|credential)$/i,
  /^x-goog-signature$/i,
];

function queryParamIsDenied(name: string): boolean {
  if (headerIsDenied(name)) return true;
  return QUERY_PARAM_DENYLIST.some((re) => re.test(name));
}

/** `Authorization` → `authorization`, `X-Api-Key` → `xApiKey`. */
function toVarName(headerName: string): string {
  const parts = headerName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return 'secret';
  return parts.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}

function maskText(input: string): string {
  let text = input;
  for (const re of BODY_TOKEN_PATTERNS) {
    text = text.replace(re, MASK);
  }
  return text;
}

function maskBody(body: CapturedBody | undefined): void {
  if (!body) return;
  if (body.text) body.text = maskText(body.text);
  // Token-bearing payloads (e.g. a JWT in a WebSocket frame) are frequently
  // captured base64-encoded; decode/mask/re-encode so they don't leak.
  if (body.base64) {
    try {
      const decoded = atob(body.base64);
      const masked = maskText(decoded);
      if (masked !== decoded) body.base64 = btoa(masked);
    } catch {
      /* not latin1-decodable (true binary) — leave as-is */
    }
  }
}

export function redactExchange(input: CapturedExchange): RedactionResult {
  const exchange = structuredClone(input);
  const secrets: RedactedSecret[] = [];
  const seen = new Set<string>();

  const recordSecret = (name: string): string => {
    const placeholder = `{{${name}}}`;
    if (!seen.has(name)) {
      seen.add(name);
      secrets.push({ name, placeholder });
    }
    return placeholder;
  };

  const redactHeaders = (headers: CapturedHeader[]): void => {
    for (const header of headers) {
      if (headerIsDenied(header.name)) header.value = recordSecret(toVarName(header.name));
    }
  };

  redactHeaders(exchange.request.headers);
  if (exchange.response) redactHeaders(exchange.response.headers);

  // Credentials routinely ride in the query string (?access_token=, ?api_key=,
  // OAuth ?code=, presigned ?X-Amz-Signature=). Redact param VALUES whose name
  // is on the same denylist, preserving the rest of the URL.
  try {
    const url = new URL(exchange.url);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (queryParamIsDenied(key)) {
        url.searchParams.set(key, recordSecret(toVarName(key)));
        changed = true;
      }
    }
    if (changed) exchange.url = url.toString().replace(/%7B%7B(\w+)%7D%7D/g, '{{$1}}');
  } catch {
    /* relative or malformed URL — nothing to parse */
  }

  maskBody(exchange.request.body);
  maskBody(exchange.response?.body);
  for (const frame of exchange.frames ?? []) maskBody(frame.payload);

  return { exchange, secrets };
}
