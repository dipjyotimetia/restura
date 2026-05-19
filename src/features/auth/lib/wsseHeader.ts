// Renderer-facing entry point for the WSSE UsernameToken builder.
//
// The actual implementation lives in `shared/protocol/wsse-header.ts` so it's
// reachable from the Cloudflare Worker bundle. This wrapper just re-types
// `authConfig` against the renderer's `AuthConfig`.

import type { AuthConfig } from '@/types';
import { unwrapSecret } from '@/lib/shared/secretRef';
import {
  buildWsseHeader as buildShared,
  buildWsseDigest as buildSharedDigest,
  type WsseDeterministicInputs,
} from '@shared/protocol/wsse-header';

export type { WsseDeterministicInputs };

export function buildWsseHeader(
  authConfig: NonNullable<AuthConfig['wsse']>,
): Promise<string> {
  return buildShared({ ...authConfig, password: unwrapSecret(authConfig.password) });
}

export function buildWsseDigest(
  authConfig: NonNullable<AuthConfig['wsse']>,
  fixed: WsseDeterministicInputs,
): Promise<string> {
  return buildSharedDigest({ ...authConfig, password: unwrapSecret(authConfig.password) }, fixed);
}
