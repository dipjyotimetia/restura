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
import { bytesToBase64, concatBytes, sha1Sync, sha256Sync, utf8 } from './crypto-utils';
import type { ProtocolAuthConfig } from './types';

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
  return bytesToBase64(hmac(sha256Sync, 64, utf8(key), utf8(baseString)));
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
  bodyParams: Record<string, string | string[]> = {}
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

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: authConfig.consumerKey,
    oauth_nonce: oauth.getNonce(),
    oauth_signature_method: sigMethod,
    oauth_timestamp: String(oauth.getTimeStamp()),
    oauth_version: '1.0',
  };
  if (authConfig.accessToken) oauthParams.oauth_token = authConfig.accessToken;

  // Per RFC 5849 §3.4.1.3.1, application/x-www-form-urlencoded body params
  // participate in the signature. addParamsToBody opts in to that behaviour.
  const extra: Array<[string, string]> = Object.entries(oauthParams);
  if (authConfig.addParamsToBody) {
    for (const [name, value] of Object.entries(bodyParams)) {
      for (const v of Array.isArray(value) ? value : [value]) extra.push([name, v]);
    }
  }

  const baseString = buildOAuth1BaseString(method, url, extra);
  const signingKey = `${oauth1PercentEncode(authConfig.consumerSecret ?? '')}&${oauth1PercentEncode(
    authConfig.accessTokenSecret ?? ''
  )}`;
  const signature = hashFn(baseString, signingKey);

  return oauth.toHeader({
    ...(oauthParams as unknown as OAuth.Authorization),
    oauth_signature: signature,
  }).Authorization;
}

/** RFC 5849 §3.6 percent-encoding: everything but ALPHA / DIGIT / `-._~`, UTF-8 first. */
export function oauth1PercentEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Decode one application/x-www-form-urlencoded component (`+` is a space); malformed stays raw. */
function formDecode(text: string): string {
  const spaced = text.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * The RFC 5849 §3.4.1 signature base string for a request whose URL (query
 * included) is exactly what goes on the wire. `params` are the other sources of
 * §3.4.1.3.1 — the `oauth_*` protocol parameters and, for a form body, its
 * decoded fields. Every name/value is decoded then re-encoded per §3.6,
 * repeated names are all kept, and pairs sort by name then value (§3.4.1.3.2).
 * `oauth_signature` and `realm` never take part.
 */
export function buildOAuth1BaseString(
  method: string,
  url: string,
  params: ReadonlyArray<readonly [string, string]>
): string {
  const u = new URL(url);
  // §3.4.1.2: scheme and host lowercase, the port only when not the default.
  const port = u.port ? `:${u.port}` : '';
  const baseUri = `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${u.pathname}`;

  const pairs: Array<[string, string]> = [];
  const query = u.search.startsWith('?') ? u.search.slice(1) : u.search;
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? '' : part.slice(eq + 1);
    pairs.push([formDecode(name), formDecode(value)]);
  }
  for (const [name, value] of params) {
    if (name === 'oauth_signature' || name === 'realm') continue;
    pairs.push([name, value]);
  }

  const normalized = pairs
    .map(([n, v]) => [oauth1PercentEncode(n), oauth1PercentEncode(v)] as const)
    .sort(([an, av], [bn, bv]) => (an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([n, v]) => `${n}=${v}`)
    .join('&');

  // RFC 5849 §3.4.1.1: the method upper-cased, and a custom method MUST be
  // percent-encoded (§3.6) — tchar allows `!`, `*`, `'` etc. outside the
  // unreserved set (#857). The server rebuilds the same form from the received
  // method, so this is deliberately not "verbatim".
  return [method.toUpperCase(), baseUri, normalized].map(oauth1PercentEncode).join('&');
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
