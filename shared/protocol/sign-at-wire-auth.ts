import type { AuthType } from '../types/auth';

/**
 * Auth that exists only as a wire signature or a challenge round-trip (no
 * static header to precompute). A bare streaming GET (SSE) or a WebSocket
 * upgrade (GraphQL subscriptions) signs nothing, so every such path — app and
 * CLI — refuses these instead of connecting unauthenticated. One list, so a new
 * sign-at-wire type is refused everywhere at once.
 */
export const SIGN_AT_WIRE_AUTH_LABELS: Readonly<Partial<Record<AuthType, string>>> = {
  'aws-signature': 'AWS Signature',
  oauth1: 'OAuth 1.0',
  wsse: 'WSSE',
  digest: 'Digest',
  ntlm: 'NTLM',
};

/** The user-facing label of a sign-at-wire auth type, or undefined when a header suffices. */
export function signAtWireAuthLabel(type: AuthType | undefined): string | undefined {
  return type ? SIGN_AT_WIRE_AUTH_LABELS[type] : undefined;
}
