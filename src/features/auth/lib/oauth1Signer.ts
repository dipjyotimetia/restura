// Renderer-facing entry point for the OAuth 1.0a signer.
//
// The actual implementation lives in `shared/protocol/oauth1-signer.ts` so
// it's reachable from the Cloudflare Worker bundle (which can't import from
// `src/`). The renderer-side wrapper re-types `authConfig` against the
// renderer's `AuthConfig` shape — the shared `ProtocolAuthConfig.oauth1`
// is structurally identical, so this is a zero-cost adapter.

import type { AuthConfig } from '@/types';
import { buildOAuth1Header as buildShared } from '@shared/protocol/oauth1-signer';

export { hmacSha1Base64, hmacSha256Base64 } from '@shared/protocol/oauth1-signer';

export function buildOAuth1Header(
  method: string,
  url: string,
  authConfig: NonNullable<AuthConfig['oauth1']>,
  bodyParams: Record<string, string> = {},
): string {
  return buildShared(method, url, authConfig, bodyParams);
}
