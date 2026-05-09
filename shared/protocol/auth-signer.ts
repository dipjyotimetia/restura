// AWS Signature Version 4 signing — pure Web Crypto, runs in both Worker and
// Electron environments. Adapted from the legacy renderer-side awsSigV4.ts.
//
// Why sign-at-wire: SigV4 hashes the body bytes; if the renderer signs a
// reconstructed body and the worker (or any intermediary) re-encodes it
// (e.g. multipart boundary regenerated, JSON whitespace normalised), the
// upstream sees a payload hash mismatch and returns SignatureDoesNotMatch.
// Signing inside the proxy — after body construction, before the fetcher —
// guarantees we sign the exact bytes the upstream receives.

import type { ProtocolAuthConfig } from './types';

export interface ApplyAuthArgs {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: BodyInit | undefined;
}

export interface AppliedAuth {
  /** Headers to merge into the outbound request. */
  headers: Record<string, string>;
}

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
  const keyBuf =
    key instanceof Uint8Array
      ? (key.slice().buffer as ArrayBuffer)
      : key;
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
    return sha256HexFromBytes(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    );
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

interface SigV4Credentials {
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
}

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
  const canonicalHeadersMap: Record<string, string> = {
    host: parsedUrl.hostname,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate,
  };

  // Skip headers that AWS doesn't expect to see in the signed set, plus any
  // that fetch/undici may rewrite mid-flight (content-length, user-agent).
  const skipHeaders = new Set([
    'authorization',
    'content-length',
    'user-agent',
    'accept-encoding',
  ]);
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
 * Apply auth that requires the exact wire-bytes (currently AWS SigV4).
 * Bearer / Basic / API-key / OAuth2 are still applied client-side
 * because they don't depend on the request body or its content-type.
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

  if (auth.type === 'aws-signature') {
    if (!auth.awsSignature) {
      throw new Error('AWS SigV4 auth selected but awsSignature config missing');
    }
    const headers = await signSigV4(args, auth.awsSignature);
    return { headers };
  }

  // Other auth types are handled in the renderer (applyAuthHeaders.ts).
  return { headers: {} };
}
