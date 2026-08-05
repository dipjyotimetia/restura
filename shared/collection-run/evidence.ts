import { CREDENTIAL_HEADER_NAMES } from '../protocol/credential-header-names';
import { bodyTokenPatterns, headerDenylistRegex } from '../protocol/secret-patterns';
import type { Response } from '../types/http';

export type ResponseRetentionMode = 'metadata' | 'failures' | 'all';

export interface ResponseEvidence {
  contentType: string;
  /** Wire response size reported by the protocol executor, before excerpt bounds. */
  sizeBytes: number;
  /** Only safe diagnostic headers; credential-bearing and redirect headers are excluded. */
  headers: Record<string, string>;
  /** SHA-256 of the redacted full text body, present only when text retention is enabled. */
  hash?: string;
  /** Sanitized UTF-8 prefix. Omitted for metadata-only and non-text responses. */
  excerpt?: string;
  truncated: boolean;
  redacted: boolean;
  binary: boolean;
  /** No safe body was retained; this is distinct from a genuinely empty excerpt. */
  unavailable: boolean;
}

export const RESPONSE_EVIDENCE_LIMITS = {
  failureExcerptBytes: 64 * 1024,
  allExcerptBytes: 16 * 1024,
  perRunBytes: 2 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
} as const;

const SAFE_HEADER_NAMES = new Set([
  'cache-control',
  'content-length',
  'content-type',
  'date',
  'etag',
  'retry-after',
  'www-authenticate',
  'x-correlation-id',
  'x-request-id',
]);
const CREDENTIAL_HEADERS = new Set(CREDENTIAL_HEADER_NAMES);
const HEADER_DENYLIST = headerDenylistRegex();
const BODY_TOKEN_PATTERNS = bodyTokenPatterns();
const MASK = '[REDACTED]';

function firstHeaderValue(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

function isCredentialHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    CREDENTIAL_HEADERS.has(normalized) || HEADER_DENYLIST.some((pattern) => pattern.test(name))
  );
}

function redactText(value: string): { value: string; redacted: boolean } {
  let text = value;
  for (const pattern of BODY_TOKEN_PATTERNS) text = text.replace(pattern, MASK);
  return { value: text, redacted: text !== value };
}

function safeHeaders(input: Response['headers']): {
  headers: Record<string, string>;
  redacted: boolean;
} {
  const headers: Record<string, string> = {};
  let redacted = false;
  for (const [name, rawValue] of Object.entries(input)) {
    const normalized = name.toLowerCase();
    if (isCredentialHeader(name)) {
      redacted = true;
      continue;
    }
    if (!SAFE_HEADER_NAMES.has(normalized)) continue;
    const value = firstHeaderValue(rawValue);
    const sanitized = redactText(value);
    headers[normalized] = sanitized.value.slice(0, 1024);
    redacted ||= sanitized.redacted || value.length > 1024;
  }
  return { headers, redacted };
}

function isTextResponse(response: Response, contentType: string): boolean {
  if (response.bodyEncoding === 'base64') return false;
  const essence = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (essence === '') return true;
  return (
    essence.startsWith('text/') ||
    essence.includes('json') ||
    essence.includes('xml') ||
    essence.includes('javascript') ||
    essence.includes('graphql') ||
    essence === 'application/x-www-form-urlencoded'
  );
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}

/** Build evidence that is safe to persist, compare, or export. Never returns raw binary bytes. */
export async function buildResponseEvidence(
  response: Response,
  retention: ResponseRetentionMode
): Promise<ResponseEvidence> {
  const headerResult = safeHeaders(response.headers);
  const contentType = headerResult.headers['content-type'] ?? '';
  const binary = !isTextResponse(response, contentType);
  const base: ResponseEvidence = {
    contentType,
    sizeBytes: Math.max(0, response.size),
    headers: headerResult.headers,
    truncated: false,
    redacted: headerResult.redacted,
    binary,
    unavailable: retention === 'metadata' || binary,
  };
  if (retention === 'metadata' || binary) return base;

  const sanitized = redactText(response.body);
  const maxBytes =
    retention === 'failures'
      ? RESPONSE_EVIDENCE_LIMITS.failureExcerptBytes
      : RESPONSE_EVIDENCE_LIMITS.allExcerptBytes;
  const excerpt = truncateUtf8(sanitized.value, maxBytes);
  return {
    ...base,
    hash: await sha256Hex(sanitized.value),
    excerpt: excerpt.value,
    truncated: excerpt.truncated,
    redacted: base.redacted || sanitized.redacted,
    unavailable: false,
  };
}

/** UTF-8 encoded serialized size, shared by per-run and global quota enforcement. */
export function evidenceBytes(evidence: ResponseEvidence | undefined): number {
  return evidence ? new TextEncoder().encode(JSON.stringify(evidence)).byteLength : 0;
}
