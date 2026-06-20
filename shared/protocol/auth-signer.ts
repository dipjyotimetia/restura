// Sign-at-wire auth signers — pure Web Crypto / pure JS, runs in both Worker
// and Electron environments. Adapted from the legacy renderer-side awsSigV4.ts.
//
// Why sign-at-wire:
//   - AWS SigV4 hashes the body bytes; if the renderer signs a reconstructed
//     body and the worker (or any intermediary) re-encodes it (e.g. multipart
//     boundary regenerated, JSON whitespace normalised), the upstream sees a
//     payload hash mismatch and returns SignatureDoesNotMatch.
//   - OAuth 1.0a's signature includes the request URL (with query params),
//     method, and — when `addParamsToBody` is set — the form-encoded body.
//     Signing inside the proxy guarantees the URL we sign is the URL we send.
//   - WSSE doesn't depend on the body, but living next to the others keeps
//     the auth pipeline in one place.
//
// Signing inside the proxy — after body construction, before the fetcher —
// keeps the renderer ignorant of wire-byte details and centralises the auth
// pipeline so Electron + Worker behave identically.

import type { ProtocolAuthConfig, ProtocolSecretValue } from './types';
import { isProtocolSecretHandle } from './secret-value-schema';
import { buildOAuth1Header } from './oauth1-signer';
import { buildWsseHeader } from './wsse-header';

/**
 * Resolves a ProtocolSecretValue to plaintext. Default behaviour:
 *  - plain string → returned as-is
 *  - `{kind:'inline', value}` → value
 *  - `{kind:'handle', id}` → throws (Worker has no keychain; Electron passes
 *    `unwrapSecretValueMain` as the resolver to look up handles)
 */
export type SecretResolver = (value: ProtocolSecretValue | undefined) => string;

/** Default resolver — inline-only. Throws on handle so the Worker fails loudly. */
export const inlineOnlySecretResolver: SecretResolver = (value) => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (isProtocolSecretHandle(value)) {
    throw new Error(
      'Secret handle encountered at sign-at-wire boundary but no resolver was supplied — ' +
        'this typically means the Worker is processing a desktop-only handle. Use the desktop app.'
    );
  }
  return value.value;
};

export interface ApplyAuthArgs {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: BodyInit | undefined;
  /**
   * Resolves SecretValue fields to plaintext. Electron passes
   * `unwrapSecretValueMain`; Worker omits this (or passes `inlineOnlySecretResolver`)
   * so handles throw rather than silently signing with empty creds.
   */
  resolveSecret?: SecretResolver;
  /**
   * Optional override for the AWS SigV4 signing step. Electron passes a signer
   * backed by the official `@smithy/signature-v4` (Node-only); the Worker omits
   * this and falls back to the built-in pure-Web-Crypto `signSigV4` so the
   * Worker bundle stays free of the AWS SDK.
   */
  sigV4Signer?: SigV4Signer;
}

export interface AppliedAuth {
  /** Headers to merge into the outbound request. */
  headers: Record<string, string>;
}

/** Credentials + scope for an AWS SigV4 signature. */
export interface SigV4Credentials {
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
}

/**
 * Produces the SigV4 auth headers (Authorization, x-amz-date, …) for a request.
 * The built-in `signSigV4` implements this with Web Crypto; Electron may inject
 * an `@smithy/signature-v4`-backed implementation via {@link ApplyAuthArgs}.
 */
export type SigV4Signer = (
  args: ApplyAuthArgs,
  creds: SigV4Credentials
) => Promise<Record<string, string>>;

// ---------------------------------------------------------------------------
// Crypto primitives (Web Crypto only — no Node Buffer required)
// ---------------------------------------------------------------------------

const UNSIGNED_PAYLOAD_HASH = 'UNSIGNED-PAYLOAD';

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  // Crypto requires a fresh ArrayBuffer view; passing the Uint8Array's underlying
  // buffer can include unrelated bytes if it's a sub-view. Slice first.
  const view = bytes.slice();
  const hash = await crypto.subtle.digest('SHA-256', view);
  return bufToHex(hash);
}

async function sha256HexFromString(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  return sha256HexFromBytes(bytes);
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyBuf = key instanceof Uint8Array ? (key.slice().buffer as ArrayBuffer) : key;
  const importedKey = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', importedKey, new TextEncoder().encode(data));
}

async function deriveSigningKey(
  secretKey: string,
  date: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode(`AWS4${secretKey}`), date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

// ---------------------------------------------------------------------------
// Body → bytes for hashing
// ---------------------------------------------------------------------------

/**
 * Hash the request body for use in the SigV4 canonical request.
 *
 * Returns `UNSIGNED-PAYLOAD` for body shapes whose wire encoding is not
 * deterministic at this stage (FormData generates a fresh boundary at fetch
 * time, ReadableStream is consumed once). AWS supports unsigned payloads
 * via the `x-amz-content-sha256: UNSIGNED-PAYLOAD` header for streaming /
 * multipart use cases, so this preserves functionality at the cost of a
 * slightly weaker integrity guarantee for those shapes.
 */
async function hashBody(body: BodyInit | undefined): Promise<string> {
  if (body === undefined || body === null) {
    return sha256HexFromString('');
  }
  if (typeof body === 'string') {
    return sha256HexFromString(body);
  }
  // ArrayBufferView (Uint8Array and other TypedArrays). We use ArrayBuffer.isView
  // rather than `instanceof Uint8Array` because cross-realm TypedArrays (e.g.
  // produced by TextEncoder under jsdom vs the test runtime) can fail an
  // instanceof check while still being valid Uint8Arrays structurally.
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return sha256HexFromBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (body instanceof ArrayBuffer) {
    return sha256HexFromBytes(new Uint8Array(body));
  }
  // FormData / Blob / URLSearchParams / ReadableStream — wire encoding isn't
  // accessible here without consuming/serialising. Fall back to UNSIGNED-PAYLOAD.
  return UNSIGNED_PAYLOAD_HASH;
}

// ---------------------------------------------------------------------------
// SigV4 canonical request + string-to-sign + signature
// ---------------------------------------------------------------------------

async function signSigV4(
  args: ApplyAuthArgs,
  creds: SigV4Credentials
): Promise<Record<string, string>> {
  if (!creds.accessKey || !creds.secretKey || !creds.region || !creds.service) {
    throw new Error('AWS SigV4 requires accessKey, secretKey, region, and service');
  }

  const parsedUrl = new URL(args.url);
  const now = new Date();
  // ISO 8601 basic format: 20060102T150405Z (no dashes / colons / millis).
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const bodyHash = await hashBody(args.body);

  // Build canonical headers (must be sorted, lowercase keys, trimmed values).
  // host + x-amz-date + x-amz-content-sha256 are always part of the signed set.
  // Use `host` (not `hostname`) so a non-default port is included — the signed
  // value must match the wire `Host` header, which carries the port (e.g.
  // `localhost:8080`). URL.host omits the port only for default 80/443.
  const canonicalHeadersMap: Record<string, string> = {
    host: parsedUrl.host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate,
  };

  // Skip headers that AWS doesn't expect to see in the signed set, plus any
  // that fetch/undici may rewrite mid-flight (content-length, user-agent).
  const skipHeaders = new Set(['authorization', 'content-length', 'user-agent', 'accept-encoding']);
  for (const [k, v] of Object.entries(args.headers)) {
    const lk = k.toLowerCase();
    if (!skipHeaders.has(lk) && !(lk in canonicalHeadersMap)) {
      canonicalHeadersMap[lk] = v.trim();
    }
  }

  const sortedHeaderKeys = Object.keys(canonicalHeadersMap).sort();
  const canonicalHeaders =
    sortedHeaderKeys.map((k) => `${k}:${canonicalHeadersMap[k]}`).join('\n') + '\n';
  const signedHeaders = sortedHeaderKeys.join(';');

  // Canonical query string: keys sorted, values percent-encoded.
  const queryParams = Array.from(parsedUrl.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    args.method.toUpperCase(),
    parsedUrl.pathname || '/',
    queryParams,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${creds.region}/${creds.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256HexFromString(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(
    creds.secretKey,
    dateStamp,
    creds.region,
    creds.service
  );
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = bufToHex(signatureBytes);

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': bodyHash,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Apply auth that needs to be computed against the canonical request that
 * the proxy will actually emit (URL with query params, body bytes, etc.):
 *
 *   - AWS SigV4 — hashes body bytes; must sign post-body-construction.
 *   - OAuth 1.0a — signature includes URL + method (and optionally body
 *     params); building the header against the renderer-side URL would
 *     miss query params the proxy may add via spec.params.
 *   - WSSE — independent of body, but lives here so the auth pipeline is
 *     centralised and the renderer doesn't have to replicate the SHA-1
 *     digest logic.
 *
 * Bearer / Basic / API-key / OAuth2 are still applied client-side because
 * they don't depend on URL canonicalisation or body bytes (see
 * src/features/http/lib/applyAuthHeaders.ts).
 *
 * Returns the headers to merge into the outbound request. Throws on
 * misconfiguration so the caller can surface a 500 to the renderer.
 */
export async function applyAuth(
  auth: ProtocolAuthConfig | undefined,
  args: ApplyAuthArgs
): Promise<AppliedAuth> {
  if (!auth || auth.type === 'none') {
    return { headers: {} };
  }
  const resolve = args.resolveSecret ?? inlineOnlySecretResolver;

  if (auth.type === 'aws-signature') {
    if (!auth.awsSignature) {
      throw new Error('AWS SigV4 auth selected but awsSignature config missing');
    }
    const sign = args.sigV4Signer ?? signSigV4;
    const headers = await sign(args, {
      accessKey: auth.awsSignature.accessKey,
      secretKey: resolve(auth.awsSignature.secretKey),
      region: auth.awsSignature.region,
      service: auth.awsSignature.service,
    });
    return { headers };
  }

  if (auth.type === 'oauth1') {
    if (!auth.oauth1) {
      // Defensive: missing config shouldn't crash the proxy. Log and skip so
      // the request still goes through (auth will fail upstream with 401,
      // surfacing the misconfiguration to the user).
      console.warn('OAuth1 auth selected but oauth1 config missing — skipping');
      return { headers: {} };
    }
    let bodyParams: Record<string, string> = {};
    // Parse body as form params only when addParamsToBody is set and the body
    // is a plain string we can interpret as application/x-www-form-urlencoded.
    if (auth.oauth1.addParamsToBody && typeof args.body === 'string') {
      try {
        for (const [k, v] of new URLSearchParams(args.body).entries()) {
          bodyParams[k] = v;
        }
      } catch {
        // Malformed body — fall through with empty bodyParams.
        bodyParams = {};
      }
    }
    const o1 = auth.oauth1;
    const resolvedOauth1 = {
      consumerKey: o1.consumerKey,
      consumerSecret: resolve(o1.consumerSecret),
      ...(o1.accessToken !== undefined ? { accessToken: resolve(o1.accessToken) } : {}),
      ...(o1.accessTokenSecret !== undefined
        ? { accessTokenSecret: resolve(o1.accessTokenSecret) }
        : {}),
      ...(o1.signatureMethod !== undefined ? { signatureMethod: o1.signatureMethod } : {}),
      ...(o1.realm !== undefined ? { realm: o1.realm } : {}),
      ...(o1.nonce !== undefined ? { nonce: o1.nonce } : {}),
      ...(o1.timestamp !== undefined ? { timestamp: o1.timestamp } : {}),
      ...(o1.addParamsToBody !== undefined ? { addParamsToBody: o1.addParamsToBody } : {}),
    };
    const authHeader = buildOAuth1Header(args.method, args.url, resolvedOauth1, bodyParams);
    return { headers: { Authorization: authHeader } };
  }

  if (auth.type === 'wsse') {
    if (!auth.wsse) {
      console.warn('WSSE auth selected but wsse config missing — skipping');
      return { headers: {} };
    }
    const wsseValue = await buildWsseHeader({
      username: auth.wsse.username,
      password: resolve(auth.wsse.password),
      ...(auth.wsse.passwordType !== undefined ? { passwordType: auth.wsse.passwordType } : {}),
    });
    return { headers: { 'X-WSSE': wsseValue } };
  }

  // Other auth types are handled in the renderer (applyAuthHeaders.ts).
  return { headers: {} };
}
