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
