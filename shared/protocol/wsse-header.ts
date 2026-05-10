// WSSE UsernameToken header builder.
//
// Lives in shared/ so it can be invoked from both the Cloudflare Worker
// (`applyAuth` in auth-signer.ts) and the renderer (re-exported via
// src/features/auth/lib/wsseHeader.ts).
//
// Implements WS-Security UsernameToken Profile 1.1 (Atom Publishing-style WSSE):
//
//   X-WSSE: UsernameToken Username="<u>", PasswordDigest="<base64( sha1(nonce + created + password) )>",
//                          Nonce="<base64 nonce>", Created="<ISO timestamp>"
//
// PasswordText form (sends the password verbatim) is supported but discouraged
// outside of TLS — included only for compatibility with services that demand it.
//
// Runs in the browser, Cloudflare Worker, and Electron renderer/main: uses
// Web Crypto's SHA-1 when available and falls back to a tiny pure-JS SHA-1
// implementation otherwise.

import type { ProtocolAuthConfig } from './types';
import { bytesToBase64, concatBytes, randomBytes, sha1, utf8 } from './crypto-utils';

type WsseConfig = NonNullable<ProtocolAuthConfig['wsse']>;

// Test-only knobs. Normal callers use the public API which generates a fresh
// nonce + timestamp per call. The deterministic builder below is exposed for
// unit tests that need to assert exact digest values.
export interface WsseDeterministicInputs {
  nonce: Uint8Array;
  created: string;
}

/**
 * Build the X-WSSE header value for UsernameToken authentication.
 *
 * For PasswordDigest (default): generates a fresh 16-byte nonce and current
 * ISO-8601 UTC timestamp per call. The digest is base64( sha1( nonce + created + password ) ).
 *
 * For PasswordText: emits Username + PasswordText only.
 */
export async function buildWsseHeader(authConfig: WsseConfig): Promise<string> {
  if (!authConfig.username) {
    throw new Error('WSSE auth requires a username');
  }

  const passwordType = authConfig.passwordType ?? 'PasswordDigest';

  if (passwordType === 'PasswordText') {
    // Format: `UsernameToken <attr>, <attr>, ...` — first separator is a
    // space (per WSSE auth scheme convention), subsequent ones are commas.
    return [
      `UsernameToken Username="${escapeQuoted(authConfig.username)}"`,
      `PasswordText="${escapeQuoted(authConfig.password ?? '')}"`,
    ].join(', ');
  }

  return buildWsseDigest(authConfig, {
    nonce: randomBytes(16),
    created: new Date().toISOString(),
  });
}

/**
 * Deterministic variant for tests: pass an explicit nonce + created and the
 * function returns the X-WSSE header reproducibly.
 */
export async function buildWsseDigest(
  authConfig: WsseConfig,
  fixed: WsseDeterministicInputs,
): Promise<string> {
  const { nonce, created } = fixed;
  const password = authConfig.password ?? '';

  // RFC: digest = SHA1( nonce + created + password ), base64-encoded.
  // The nonce is the raw bytes (NOT the base64 form) per WSSE 1.1 §3.1.
  const composed = concatBytes(nonce, utf8(created), utf8(password));
  const digestBytes = await sha1(composed);

  return [
    `UsernameToken Username="${escapeQuoted(authConfig.username)}"`,
    `PasswordDigest="${bytesToBase64(digestBytes)}"`,
    `Nonce="${bytesToBase64(nonce)}"`,
    `Created="${created}"`,
  ].join(', ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeQuoted(s: string): string {
  // Escape the few characters that would terminate the quoted attribute value.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
