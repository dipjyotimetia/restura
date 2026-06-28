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

/** `Authorization` → `authorization`, `X-Api-Key` → `xApiKey`. */
function toVarName(headerName: string): string {
  const parts = headerName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return 'secret';
  return parts.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}

function maskBody(body: CapturedBody | undefined): void {
  if (!body?.text) return;
  let text = body.text;
  for (const re of BODY_TOKEN_PATTERNS) {
    text = text.replace(re, MASK);
  }
  body.text = text;
}

export function redactExchange(input: CapturedExchange): RedactionResult {
  const exchange = structuredClone(input);
  const secrets: RedactedSecret[] = [];
  const seen = new Set<string>();

  const redactHeaders = (headers: CapturedHeader[]): void => {
    for (const header of headers) {
      if (!headerIsDenied(header.name)) continue;
      const name = toVarName(header.name);
      const placeholder = `{{${name}}}`;
      header.value = placeholder;
      if (!seen.has(name)) {
        seen.add(name);
        secrets.push({ name, placeholder });
      }
    }
  };

  redactHeaders(exchange.request.headers);
  if (exchange.response) redactHeaders(exchange.response.headers);

  maskBody(exchange.request.body);
  maskBody(exchange.response?.body);
  for (const frame of exchange.frames ?? []) maskBody(frame.payload);

  return { exchange, secrets };
}
