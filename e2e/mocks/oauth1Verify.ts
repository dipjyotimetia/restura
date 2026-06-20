// Independent OAuth 1.0a (RFC 5849) signature verifier for the mock auth server.
//
// Deliberately does NOT share code with the client signer (`shared/protocol/
// oauth1-signer.ts`, which wraps the `oauth-1.0a` package). A verifier that
// reused the signer's logic would pass even if both shared a bug — so this is
// a from-scratch RFC 5849 §3.4.1 implementation using node:crypto. Its base-
// string construction is validated against the RFC 5849 §3.4.1.1 worked example
// (see oauth1Verify.test.ts) before it is trusted to judge the client.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** RFC 3986 percent-encoding (unreserved = A-Za-z0-9-._~). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Parse an `Authorization: OAuth k="v", ...` header into a param map (values rfc3986-decoded). */
export function parseOAuthHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^OAuth\s+/i, '');
  for (const part of body.split(',')) {
    const m = /^\s*([^=]+)="(.*)"\s*$/.exec(part);
    if (!m) continue;
    out[m[1]!.trim()] = decodeURIComponent(m[2]!);
  }
  return out;
}

/** The base-URI per RFC 5849 §3.4.1.2: scheme://host[:non-default-port]/path. */
function baseStringUri(fullUrl: string): string {
  const u = new URL(fullUrl);
  const scheme = u.protocol.replace(':', '').toLowerCase();
  const host = u.hostname.toLowerCase();
  const isDefault =
    (scheme === 'http' && (u.port === '' || u.port === '80')) ||
    (scheme === 'https' && (u.port === '' || u.port === '443'));
  const authority = isDefault ? host : `${host}:${u.port}`;
  return `${scheme}://${authority}${u.pathname}`;
}

/**
 * Build the RFC 5849 §3.4.1 signature base string from the request method, URL
 * (query params included), the OAuth header params, and any form-body params.
 * `oauth_signature` and `realm` are excluded from the parameter set per §3.4.1.3.
 */
export function buildBaseString(
  method: string,
  fullUrl: string,
  oauthParams: Record<string, string>,
  bodyParams: Record<string, string> = {}
): string {
  const params: Array<[string, string]> = [];
  const u = new URL(fullUrl);
  u.searchParams.forEach((v, k) => params.push([k, v]));
  for (const [k, v] of Object.entries(bodyParams)) params.push([k, v]);
  for (const [k, v] of Object.entries(oauthParams)) {
    if (k === 'oauth_signature' || k === 'realm') continue;
    params.push([k, v]);
  }

  const encoded = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  return `${method.toUpperCase()}&${rfc3986(baseStringUri(fullUrl))}&${rfc3986(encoded)}`;
}

export interface OAuth1Secrets {
  consumerSecret: string;
  tokenSecret?: string;
}

/**
 * Verify an OAuth 1.0a signed request. Returns the parsed params + whether the
 * signature is valid. Supports HMAC-SHA1, HMAC-SHA256, and PLAINTEXT.
 */
export function verifyOAuth1(
  method: string,
  fullUrl: string,
  authHeader: string,
  secrets: OAuth1Secrets,
  bodyParams: Record<string, string> = {}
): { valid: boolean; params: Record<string, string> } {
  const params = parseOAuthHeader(authHeader);
  const provided = params.oauth_signature;
  if (!provided) return { valid: false, params };

  const signingKey = `${rfc3986(secrets.consumerSecret)}&${rfc3986(secrets.tokenSecret ?? '')}`;
  const sigMethod = params.oauth_signature_method ?? 'HMAC-SHA1';

  let expected: string;
  if (sigMethod === 'PLAINTEXT') {
    expected = signingKey;
  } else {
    const algo = sigMethod === 'HMAC-SHA256' ? 'sha256' : 'sha1';
    const baseString = buildBaseString(method, fullUrl, params, bodyParams);
    expected = createHmac(algo, signingKey).update(baseString).digest('base64');
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && timingSafeEqual(a, b);
  return { valid, params };
}
