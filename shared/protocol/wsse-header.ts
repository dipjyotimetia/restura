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

  const enc = new TextEncoder();
  // RFC: digest = SHA1( nonce + created + password ), base64-encoded.
  // The nonce is the raw bytes (NOT the base64 form) per WSSE 1.1 §3.1.
  const composed = concat(nonce, enc.encode(created), enc.encode(password));
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

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(out);
    return out;
  }
  // Math.random fallback — only reached in degenerate environments. WSSE
  // nonces don't need cryptographic randomness for replay protection in
  // most stacks (the timestamp is the primary freshness signal), but we
  // try to do better when we can.
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function bytesToBase64(b: Uint8Array): string {
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
    return btoa(s);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).Buffer.from(b).toString('base64');
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.digest === 'function'
  ) {
    // Slice into a fresh ArrayBuffer — TypedArray sub-views can carry extra
    // bytes that crypto.subtle.digest would otherwise hash.
    const buf = await crypto.subtle.digest('SHA-1', data.slice());
    return new Uint8Array(buf);
  }
  return sha1Fallback(data);
}

// ---------------------------------------------------------------------------
// Pure-JS SHA-1 fallback (FIPS 180-4 §6.1) — only used when crypto.subtle
// is unavailable.
// ---------------------------------------------------------------------------

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function sha1Fallback(message: Uint8Array): Uint8Array {
  const ml = message.length;
  const bitLen = ml * 8;
  const padLen = (56 - ((ml + 1) % 64) + 64) % 64;
  const total = ml + 1 + padLen + 8;
  const padded = new Uint8Array(total);
  padded.set(message);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);
  for (let chunk = 0; chunk < total; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(chunk + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl32((w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) >>> 0, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl32(a, 5) + (f >>> 0) + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false);
  odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false);
  return out;
}
