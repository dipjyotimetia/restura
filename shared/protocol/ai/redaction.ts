/**
 * AI redaction — single source of truth for what the AI sees.
 *
 * Runs in the renderer before the request hits the IPC boundary. The backend
 * runs `detectUnredactedSecrets` as a defense-in-depth check and rejects the
 * call (HTTP 400) if anything obviously slipped through.
 *
 * `mode: 'raw'` is the per-message "Send raw" toggle. The toggle never sticks
 * — every new user message starts in `default` mode regardless.
 */

export type RedactionMode = 'default' | 'raw';

const HEADER_DENYLIST_EXACT = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
]);

const HEADER_DENYLIST_REGEX: RegExp[] = [
  /^x-.*-token$/i,
  /^x-.*-key$/i,
  /^x-.*-secret$/i,
];

const BODY_TOKEN_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g,
  /(api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}/gi,
];

function headerIsDenied(name: string): boolean {
  const lower = name.toLowerCase();
  if (HEADER_DENYLIST_EXACT.has(lower)) return true;
  return HEADER_DENYLIST_REGEX.some((re) => re.test(lower));
}

export function redactHeaders(
  headers: Record<string, string>,
  mode: RedactionMode,
): Record<string, string> {
  if (mode === 'raw') return { ...headers };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = headerIsDenied(k) ? '[REDACTED]' : v;
  }
  return out;
}

export function redactBody(body: string, mode: RedactionMode): string {
  if (mode === 'raw') return body;
  let out = body;
  for (const re of BODY_TOKEN_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

export function redactEnvironment(
  env: Record<string, string>,
  mode: RedactionMode,
): Record<string, string> {
  if (mode === 'raw') return { ...env };
  const out: Record<string, string> = {};
  for (const k of Object.keys(env)) out[k] = '[REDACTED]';
  return out;
}

/**
 * Backend paranoia check. Called by ai-proxy.ts on the assembled messages[]
 * content before the upstream provider call. If this returns true AND rawMode
 * is false, the request is rejected as a renderer programming error.
 */
export function detectUnredactedSecrets(text: string): boolean {
  for (const re of BODY_TOKEN_PATTERNS) {
    // Reset lastIndex because the regexes are /g — stateful across calls.
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}
