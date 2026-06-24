// OAuth 1.0a signer.
//
// Lives in shared/ so it can run inside the Cloudflare Worker (where node:crypto
// isn't reliably available) and the Electron main process. The renderer
// re-exports this module via src/features/auth/lib/oauth1Signer.ts.
//
// Wraps the `oauth-1.0a` package, which expects a *synchronous* `hash_function`.
// Web Crypto's `crypto.subtle` HMAC API is async, and dynamic-importing
// `node:crypto` is awkward in the renderer (it's not present in the browser
// runtime), so we ship a small pure-JS HMAC-SHA1 / HMAC-SHA256 implementation
// here. This keeps the signer working uniformly in:
//   - the renderer / browser (jsdom, Vite dev, Electron renderer)
//   - the Cloudflare Worker (no node:crypto)
//   - the Electron main process (Node)
//
// The HMAC implementation is RFC 2104 / FIPS 180-4 compliant and verified
// against published test vectors (see the colocated test file).

import OAuth from 'oauth-1.0a';
import { bytesToBase64, concatBytes, sha1Sync, utf8 } from './crypto-utils';
import type { ProtocolAuthConfig } from './types';

// ---------------------------------------------------------------------------
// SHA-256 — pure-JS, sync. SHA-1 lives in crypto-utils (shared with WSSE).
// Fed into oauth-1.0a's hash_function alongside sha1Sync.
// ---------------------------------------------------------------------------

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

// SHA-256 round constants (FIPS 180-4 §4.2.2).
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 (FIPS 180-4 §6.2). Returns a 32-byte digest as a Uint8Array.
 */
function sha256(message: Uint8Array): Uint8Array {
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

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let chunk = 0; chunk < total; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(chunk + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + mj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false);
  odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false);
  odv.setUint32(20, h5, false);
  odv.setUint32(24, h6, false);
  odv.setUint32(28, h7, false);
  return out;
}

// HMAC (RFC 2104). Block size is 64 bytes for both SHA-1 and SHA-256.
function hmac(
  hash: (m: Uint8Array) => Uint8Array,
  blockSize: number,
  key: Uint8Array,
  message: Uint8Array
): Uint8Array {
  let k = key;
  if (k.length > blockSize) {
    k = hash(k);
  }
  if (k.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    padded.set(k);
    k = padded;
  }
  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    oKeyPad[i] = k[i]! ^ 0x5c;
    iKeyPad[i] = k[i]! ^ 0x36;
  }
  const inner = hash(concatBytes(iKeyPad, message));
  return hash(concatBytes(oKeyPad, inner));
}

/**
 * Sync HMAC-SHA1 returning a base64-encoded digest. This is exactly the
 * shape oauth-1.0a expects from `hash_function`.
 */
export function hmacSha1Base64(baseString: string, key: string): string {
  return bytesToBase64(hmac(sha1Sync, 64, utf8(key), utf8(baseString)));
}

/**
 * Sync HMAC-SHA256 returning a base64-encoded digest.
 */
export function hmacSha256Base64(baseString: string, key: string): string {
  return bytesToBase64(hmac(sha256, 64, utf8(key), utf8(baseString)));
}

// ---------------------------------------------------------------------------
// Public OAuth 1.0a signer
// ---------------------------------------------------------------------------

/**
 * Resolved OAuth1 credentials — caller (auth-signer's `applyAuth`) has already
 * unwrapped any SecretValue fields to plaintext via the supplied resolver, so
 * this signer stays string-typed and oblivious to handles.
 */
type OAuth1Config = Omit<
  NonNullable<ProtocolAuthConfig['oauth1']>,
  'consumerSecret' | 'accessToken' | 'accessTokenSecret'
> & {
  consumerSecret: string;
  accessToken?: string | undefined;
  accessTokenSecret?: string | undefined;
};

/**
 * Compute the OAuth 1.0a Authorization header for a request.
 *
 * Returns the header string ready to be set as `Authorization`. Throws on
 * misconfiguration so the caller can surface the error.
 *
 * Notes:
 * - HMAC-SHA1 (RFC 5849 default) and HMAC-SHA256 are computed via a
 *   pure-JS HMAC implementation (sync, browser-safe, Worker-safe).
 * - PLAINTEXT is supported per spec but discouraged outside of TLS-only
 *   environments.
 * - When `addParamsToBody` is true, `bodyParams` are folded into the
 *   signature base string per RFC 5849 §3.4.1.3.1 (form-encoded POSTs).
 * - `nonce` and `timestamp` overrides exist for deterministic testing.
 */
export function buildOAuth1Header(
  method: string,
  url: string,
  authConfig: OAuth1Config,
  bodyParams: Record<string, string> = {}
): string {
  if (!authConfig.consumerKey) {
    throw new Error('OAuth1 requires consumerKey');
  }

  const sigMethod = authConfig.signatureMethod ?? 'HMAC-SHA1';
  const hashFn = getHashFunction(sigMethod);

  const opts: OAuth.Options = {
    consumer: {
      key: authConfig.consumerKey,
      secret: authConfig.consumerSecret ?? '',
    },
    signature_method: sigMethod,
    hash_function: hashFn,
  };
  if (authConfig.realm) {
    opts.realm = authConfig.realm;
  }
  if (authConfig.nonce) {
    opts.nonce_length = authConfig.nonce.length;
  }

  const oauth = new OAuth(opts);

  // Override nonce/timestamp when explicitly provided (deterministic tests,
  // re-signing scenarios). The library's `getNonce`/`getTimeStamp` are public
  // instance methods, so reassigning is supported.
  if (authConfig.nonce) {
    const fixedNonce = authConfig.nonce;
    oauth.getNonce = () => fixedNonce;
  }
  if (authConfig.timestamp) {
    const fixedTs = Number(authConfig.timestamp);
    oauth.getTimeStamp = () => fixedTs;
  }

  const token: OAuth.Token | undefined = authConfig.accessToken
    ? {
        key: authConfig.accessToken,
        secret: authConfig.accessTokenSecret ?? '',
      }
    : undefined;

  // Per RFC 5849 §3.4.1.3.1, application/x-www-form-urlencoded body params
  // participate in the signature. addParamsToBody opts in to that behaviour.
  const requestData: OAuth.RequestOptions = {
    url,
    method: method.toUpperCase(),
  };
  if (authConfig.addParamsToBody) {
    requestData.data = bodyParams;
  }

  const authData = oauth.authorize(requestData, token);
  const headerObj = oauth.toHeader(authData);
  return headerObj.Authorization;
}

function getHashFunction(method: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT'): OAuth.HashFunction {
  switch (method) {
    case 'HMAC-SHA1':
      return hmacSha1Base64;
    case 'HMAC-SHA256':
      return hmacSha256Base64;
    case 'PLAINTEXT':
      // PLAINTEXT (RFC 5849 §3.4.4): oauth_signature equals the signing
      // key — i.e. consumerSecret&accessTokenSecret. oauth-1.0a passes the
      // already-built signing key as the second arg to hash_function and
      // takes the return value as the signature, so we just echo the key.
      return (_base, key) => key;
    default: {
      const exhaustive: never = method;
      throw new Error(`Unsupported OAuth1 signature method: ${exhaustive as string}`);
    }
  }
}
