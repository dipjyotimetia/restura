import type { AuthConfig, AuthType } from '@/types';

/**
 * Auth that exists only as a wire signature or a challenge round-trip. An SSE
 * connect is a bare GET through a streaming transport that signs nothing, so
 * `buildAuthCredential` yields no header for these: connecting would go out
 * unauthenticated. Every SSE path refuses instead (the CLI mirrors this list in
 * `cli/src/runner/executors/sse.ts`).
 */
const SSE_UNSIGNABLE_AUTH: Partial<Record<AuthType, string>> = {
  'aws-signature': 'AWS Signature',
  oauth1: 'OAuth 1.0',
  wsse: 'WSSE',
  digest: 'Digest',
  ntlm: 'NTLM',
};

/** User-facing refusal for auth SSE can't apply, or undefined when it can. */
export function sseUnsupportedAuthError(auth: AuthConfig | undefined): string | undefined {
  const label = auth ? SSE_UNSIGNABLE_AUTH[auth.type] : undefined;
  if (!label) return undefined;
  return `${label} auth can't be applied to SSE connections, so the stream was not opened. Use Bearer, Basic, API key or OAuth 2.0 auth instead.`;
}
