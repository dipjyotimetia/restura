import { redactBody, redactHeaders } from '@shared/protocol/ai/redaction';
import type { AiLabReportEnvelope } from './reportEnvelope';

export const MAX_AGENT_REPORT_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_REPORT_COUNT = 20;
export const MAX_AGENT_REPORT_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_CONTENT_CHARS = 64 * 1024;
const AGGRESSIVE_CONTENT_CHARS = 4 * 1024;
const SENSITIVE_KEY = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'clientsecret',
  'password',
  'passphrase',
  'apikey',
  'xapikey',
]);

export class AgentReportTooLargeError extends Error {
  constructor() {
    super('Sanitized agent report exceeds the 2 MiB persistence limit');
    this.name = 'AgentReportTooLargeError';
  }
}

export function sanitizeAgentSuiteReportForPersistence(
  envelope: Extract<AiLabReportEnvelope, { kind: 'agent-suite' }>
): Extract<AiLabReportEnvelope, { kind: 'agent-suite' }> {
  let sanitized = sanitizeValue(envelope, MAX_CONTENT_CHARS) as typeof envelope;
  if (serializedBytes(sanitized) > MAX_AGENT_REPORT_BYTES) {
    sanitized = sanitizeValue(sanitized, AGGRESSIVE_CONTENT_CHARS) as typeof envelope;
  }
  if (serializedBytes(sanitized) > MAX_AGENT_REPORT_BYTES) throw new AgentReportTooLargeError();
  return sanitized;
}

export function retainAgentReports(
  reports: Record<string, AiLabReportEnvelope>
): Record<string, AiLabReportEnvelope> {
  const evalReports = Object.values(reports).filter((report) => report.kind === 'eval');
  const ordered = Object.values(reports)
    .filter((report) => report.kind === 'agent-suite')
    .sort((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id));
  const retained: AiLabReportEnvelope[] = [];
  let bytes = 0;
  for (const report of ordered) {
    const size = serializedBytes(report);
    if (retained.length >= MAX_AGENT_REPORT_COUNT || bytes + size > MAX_AGENT_REPORT_TOTAL_BYTES)
      continue;
    retained.push(report);
    bytes += size;
  }
  return Object.fromEntries([...evalReports, ...retained].map((report) => [report.id, report]));
}

function sanitizeValue(value: unknown, maxChars: number, key = ''): unknown {
  if (SENSITIVE_KEY.has(key.replace(/[-_\s]/g, '').toLowerCase())) return '[REDACTED]';
  if (typeof value === 'string') {
    return sanitizeString(key.toLowerCase() === 'uri' ? sanitizeUri(value) : value, maxChars);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, maxChars));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (/headers/i.test(key)) {
    const strings = Object.fromEntries(
      Object.entries(object).map(([name, candidate]) => [name, String(candidate)])
    );
    return redactHeaders(strings, 'default');
  }
  return Object.fromEntries(
    Object.entries(object).map(([childKey, child]) => [
      childKey,
      sanitizeValue(child, maxChars, childKey),
    ])
  );
}

function sanitizeString(value: string, maxChars: number): string {
  let sanitized = redactBody(redactUrl(value), 'default');
  if (sanitized.length > maxChars) {
    const removed = sanitized.length - maxChars;
    sanitized = `${sanitized.slice(0, maxChars)}\n[TRUNCATED ${removed} CHARS]`;
  }
  return sanitized;
}

function redactUrl(value: string): string {
  return value.replace(/https?:\/\/[^\s"']+/gi, (candidate) => {
    try {
      return redactParsedUrl(new URL(candidate));
    } catch {
      return candidate;
    }
  });
}

function sanitizeUri(value: string): string {
  // Scheme classification must not be bypassable with JSON-valid whitespace or
  // control prefixes. Strip only the prefix; the classified URI sanitizer then
  // either parses the web URL or discards the opaque payload entirely.
  const normalized = value.replace(/^[\s\p{C}]+/u, '');
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  if (!schemeMatch) return redactUrl(normalized);
  const scheme = schemeMatch[1]!.toLowerCase();

  if (scheme === 'http' || scheme === 'https') {
    try {
      return redactParsedUrl(new URL(normalized));
    } catch {
      return `${scheme}:[REDACTED INVALID URI]`;
    }
  }
  if (scheme === 'data') {
    const comma = normalized.indexOf(',');
    if (comma < 0) return 'data:[REDACTED INVALID URI]';
    const metadata = normalized.slice(normalized.indexOf(':') + 1, comma);
    const mediaType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+/i.exec(metadata)?.[0] ?? '';
    const base64 = /(?:^|;)base64(?:;|$)/i.test(metadata) ? ';base64' : '';
    return `data:${mediaType}${base64},[REDACTED]`;
  }
  if (scheme === 'blob') return '[REDACTED BLOB URI]';

  // Non-web URI schemes may place credentials in an opaque path where URL
  // parsing cannot distinguish identity from secret material. Preserve only
  // the scheme so persisted/exported reports remain honest about redaction.
  return `${scheme}:[REDACTED]`;
}

function redactParsedUrl(url: URL): string {
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return url.toString();
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
