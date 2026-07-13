import { redactBody, redactHeaders } from '@shared/protocol/ai/redaction';
import type { AiLabReportEnvelope } from './reportEnvelope';

export const MAX_AGENT_REPORT_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_REPORT_COUNT = 20;
export const MAX_AGENT_REPORT_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_CONTENT_CHARS = 64 * 1024;
const AGGRESSIVE_CONTENT_CHARS = 4 * 1024;
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|api[-_]?key/i;

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
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeString(value, maxChars);
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
  return value.replace(/https?:\/\/[^\s"']+/g, (candidate) => {
    try {
      const url = new URL(candidate);
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
      return url.toString();
    } catch {
      return candidate;
    }
  });
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
