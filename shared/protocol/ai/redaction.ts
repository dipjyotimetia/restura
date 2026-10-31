/**
 * AI redaction — single source of truth for what the AI sees.
 *
 * Runs in the renderer before the request hits the IPC boundary. The backend
 * (ai-proxy.ts) runs `detectUnredactedSecrets` as a defense-in-depth check and
 * aborts the stream with a `guard` error event if anything obviously slipped
 * through.
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

import { CREDENTIAL_HEADER_NAMES } from '../credential-header-names';
import { bodyTokenPatterns, headerDenylistRegex } from '../secret-patterns';
import { isLoopbackAddress, isRfc1918Address } from '../url-validation';
import { isLocalProvider, type Provider } from './types';

export type RedactionMode = 'default' | 'raw';

// Shared base set (see shared/protocol/credential-header-names.ts) keeps this
// AI-context denylist in sync with the collection-export redactor; the regexes
// below add the `x-*-token/key/secret` family on top.
// NB: `www-authenticate` is deliberately absent from the base — it's a challenge
// header (e.g. `Bearer realm=…`), not a credential, and is exactly the
// diagnostic the AI needs to explain a 401.
const HEADER_DENYLIST_EXACT = new Set(CREDENTIAL_HEADER_NAMES);

// Regex layers live in the shared leaf module so the AI redactor and the capture
// redactor can never drift. Fresh instances (the body patterns are stateful /g).
const HEADER_DENYLIST_REGEX = headerDenylistRegex();
const BODY_TOKEN_PATTERNS = bodyTokenPatterns();

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
 * is false, the stream is aborted with a `guard` error event — treating it as
 * a renderer programming error (redaction should have run already).
 */
export function detectUnredactedSecrets(text: string): boolean {
  for (const re of BODY_TOKEN_PATTERNS) {
    // Reset lastIndex because the regexes are /g — stateful across calls.
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Make an upstream error body safe to surface: remove the literal resolved key
 * (a 401 that echoes the auth header would otherwise carry it into error
 * events, eval results and persisted arena matches; ADR-0007), then pattern
 * redact, and only then clip. Order matters: clipping first could cut a key in
 * half so neither step matches it.
 */
export function scrubProviderError(body: string, apiKey: string | undefined, max: number): string {
  return scrubSecretText(body, apiKey).slice(0, max);
}

/** Shorter literals are structural noise ("a", "8080"); removing them would mangle text. */
export const MIN_SECRET_LITERAL_LENGTH = 8;

/**
 * Remove the literal key (and each line of a key with embedded CR/LF, which
 * undici quotes line by line in header errors), then pattern-redact. No clipping.
 */
export function scrubSecretText(text: string, apiKey: string | undefined): string {
  let out = text;
  if (apiKey) {
    const literals = [apiKey, ...apiKey.split(/[\r\n]+/)]
      .filter((l) => l.length >= MIN_SECRET_LITERAL_LENGTH)
      .sort((x, y) => y.length - x.length);
    for (const literal of literals) out = out.split(literal).join('[REDACTED]');
  }
  return redactBody(out, 'default');
}

/**
 * Whether the outgoing-secret check is skipped for one call. `explicit` is the
 * user's visible override (per-suite "Send unredacted", assistant "Send raw").
 * Otherwise only a local-runtime kind whose pinned, validated address is
 * loopback or RFC1918 skips it (a LAN host counts as local). A local kind
 * pointed at a public host (`openai-compatible` -> api.groq.com) is a cloud
 * call and keeps the check. Decide this in the process that resolved the
 * address, never from renderer-supplied flags.
 */
export function effectiveRawMode(
  explicit: boolean,
  provider: Provider,
  resolvedAddress: string
): boolean {
  if (explicit) return true;
  return (
    isLocalProvider(provider) &&
    (isLoopbackAddress(resolvedAddress) || isRfc1918Address(resolvedAddress))
  );
}
