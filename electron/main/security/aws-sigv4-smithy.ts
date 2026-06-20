import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import type { SigV4Signer } from '@shared/protocol/auth-signer';

/**
 * Desktop AWS SigV4 signer backed by the official `@smithy/signature-v4` — the
 * same core the AWS SDK uses. Injected into the shared `applyAuth` on the
 * Electron path (`ExecuteHttpProxyOptions.sigV4Signer`); the Cloudflare Worker
 * keeps the pure-Web-Crypto built-in so its bundle stays free of the AWS SDK.
 *
 * Credentials are the explicit user-entered access/secret keys (already resolved
 * to plaintext by `applyAuth`'s resolver) — we deliberately avoid
 * `@aws-sdk/credential-provider-node`'s environment credential chain.
 */
const SIGV4_RESPONSE_HEADERS = new Set([
  'authorization',
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-security-token',
  'host',
]);

/**
 * SigV4 hashes the body bytes. Only string/binary bodies have a deterministic
 * wire encoding at this stage; FormData/Blob/URLSearchParams/ReadableStream do
 * not (a multipart boundary is regenerated at fetch time, a stream is consumed
 * once), so we sign them with `UNSIGNED-PAYLOAD` — the same fallback the
 * built-in signer uses, and exactly what AWS expects for streaming/multipart.
 */
function isHashableBody(body: unknown): boolean {
  return typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

export const smithySigV4Signer: SigV4Signer = async (args, creds) => {
  const url = new URL(args.url);

  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] ?? '');
  }

  // `host` (with port) must match the wire Host header the fetcher sends.
  const headers: Record<string, string> = { ...args.headers, host: url.host };
  const hashable = args.body === undefined || isHashableBody(args.body);
  // A pre-set x-amz-content-sha256 is respected by SignatureV4; use it to sign
  // an unsigned payload rather than letting @aws-crypto choke on a non-buffer.
  if (!hashable) headers['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD';

  const request = new HttpRequest({
    method: args.method,
    protocol: url.protocol,
    hostname: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: url.pathname,
    query,
    headers,
    ...(hashable && args.body !== undefined ? { body: args.body } : {}),
  });

  const signer = new SignatureV4({
    credentials: { accessKeyId: creds.accessKey, secretAccessKey: creds.secretKey },
    region: creds.region,
    service: creds.service,
    sha256: Sha256,
  });

  const signed = await signer.sign(request);

  // Return only the SigV4 contribution; applyAuth merges these onto the request.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    if (typeof value === 'string' && SIGV4_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
};
