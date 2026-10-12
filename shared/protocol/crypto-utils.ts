/**
 * Shared crypto primitives used by the OAuth1 and WSSE signers.
 *
 * Both signers need pure-JS SHA-1 and small byte/base64 helpers. Keeping
 * one implementation here prevents the two SHA-1 paths from drifting and
 * keeps the per-request allocation surface small (TextEncoder is hoisted
 * to module scope so HMAC/digest paths don't allocate a fresh encoder per
 * call).
 */

const textEncoder = new TextEncoder();

/** UTF-8 encode without per-call TextEncoder allocation. */
export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/** 32-bit left rotate. */
export function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
    return btoa(s);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
  return (globalThis as any).Buffer.from(b).toString('base64');
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
  const buf = (globalThis as any).Buffer.from(b64, 'base64') as Uint8Array;
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function bytesToHex(b: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += b[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * SHA-256 → lowercase hex. Available in Worker, Electron main, and the
 * renderer via `crypto.subtle.digest`. Used by the rate-limiter token
 * fingerprint and any other "stable identifier from a secret" callsite.
 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', utf8(input).slice());
  return bytesToHex(new Uint8Array(buf));
}

// ---------------------------------------------------------------------------
// SHA-256 — pure-JS, sync. Used by the OAuth1 HMAC-SHA256 signer and by
// callers that need a digest without awaiting crypto.subtle (e.g. the
// OpenCollection exporter's content-addressed gRPC schema dedupe).
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
export function sha256Sync(message: Uint8Array): Uint8Array {
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

/** Sync SHA-256 of a UTF-8 string → lowercase hex. */
export function sha256HexSync(input: string): string {
  return bytesToHex(sha256Sync(utf8(input)));
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(out);
    return out;
  }
  // Math.random fallback — only reached in degenerate environments. Not
  // cryptographically secure; callers that depend on cryptographic
  // randomness should refuse to run in such environments.
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/**
 * SHA-1 (FIPS 180-4 §6.1). Pure-JS so it's available synchronously in
 * environments where `crypto.subtle.digest` only exposes a Promise API
 * (oauth-1.0a's `hash_function` contract is sync).
 */
export function sha1Sync(message: Uint8Array): Uint8Array {
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

/**
 * Async SHA-1 that prefers `crypto.subtle.digest` and falls back to the
 * pure-JS implementation when SubtleCrypto isn't available. Used by
 * paths that don't need a sync API (e.g. WSSE digest construction).
 */
export async function sha1(data: Uint8Array): Promise<Uint8Array> {
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
  return sha1Sync(data);
}
