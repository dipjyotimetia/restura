/**
 * AI redaction — single source of truth for what the AI sees.
 *
 * Runs in the renderer before the request hits the IPC boundary. The backend
 * runs `detectUnredactedSecrets` as a defense-in-depth check and rejects the
 * call (HTTP 400) if anything obviously slipped through.
 *
 * `mode: 'raw'` is the per-message "Send raw" toggle. The toggle never sticks
 * — every new user message starts in `default` mode regardless.
 *
 * Coverage is pattern-based, not exhaustive: it catches denylisted headers
 * (`authorization`, `cookie`, `api-key`, `private-token`, the `x-*-token/key/secret`
 * family, …), JWTs, `Bearer` tokens, `key|secret|password|token = value`
 * assignments, and prefix-recognizable provider/cloud tokens (`sk-…`, AWS `AKIA…`,
 * GitHub `ghp_…`/`github_pat_…`, Slack `xox*-…`, Google `AIza…`) even when they
 * appear bare. A fully opaque secret with no recognizable key name OR prefix
 * (e.g. an unlabelled session id in a response body) is still NOT caught here.
 * promptBuilder additionally scrubs known environment-variable values from the
 * rendered context to cover the common interpolated-secret case.
 */

export type RedactionMode = 'default' | 'raw';

const HEADER_DENYLIST_EXACT = new Set([
  'authorization',
  'authentication',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  // NB: `www-authenticate` is intentionally NOT here — it's a challenge header
  // (e.g. `Bearer realm=…`), not a credential, and is exactly the diagnostic the
  // AI needs to explain a 401.
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  // Non-`x-`-prefixed secret headers the regexes below don't reach.
  'api-key',
  'apikey',
  'api_key',
  'private-token', // GitLab
]);

const HEADER_DENYLIST_REGEX: RegExp[] = [
  /^x-.*-token$/i, // covers x-amz-security-token, x-access-token, x-gitlab-token, …
  /^x-.*-key$/i, // covers x-functions-key, x-goog-api-key, x-secret-key, …
  /^x-.*-secret$/i,
  /^api[-_]?key$/i,
];

const BODY_TOKEN_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g,
  /(api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}/gi,
  // Provider/secret tokens with a recognizable prefix — caught even when they
  // appear without "Bearer " or a key name (e.g. echoed bare in a response body).
  /\bsk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / OpenRouter keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

function headerIsDenied(name: string): boolean {
  const lower = name.toLowerCase();
  if (HEADER_DENYLIST_EXACT.has(lower)) return true;
  return HEADER_DENYLIST_REGEX.some((re) => re.test(lower));
}

export function redactHeaders(
  headers: Record<string, string>,
  mode: RedactionMode
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
  mode: RedactionMode
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
