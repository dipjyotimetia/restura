import { signAtWireAuthLabel } from '@shared/protocol/sign-at-wire-auth';
import type { AuthConfig } from '@/types';

/**
 * User-facing refusal for auth SSE can't apply, or undefined when it can. An
 * SSE connect is a bare GET through a streaming transport that signs nothing,
 * so sign-at-wire auth (the shared list, also used by the CLI) would go out
 * unauthenticated: every SSE path refuses instead.
 */
export function sseUnsupportedAuthError(auth: AuthConfig | undefined): string | undefined {
  const label = signAtWireAuthLabel(auth?.type);
  if (!label) return undefined;
  return `${label} auth can't be applied to SSE connections, so the stream was not opened. Use Bearer, Basic, API key or OAuth 2.0 auth instead.`;
}
