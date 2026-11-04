import { Sha256 } from '@aws-crypto/sha256-js';
import type { AwsRequestSigner } from '@shared/protocol/ai/provider-routes';
import {
  isS3SigningService,
  SIGV4_EXTRA_UNSIGNABLE_HEADERS,
  type SigV4Signer,
} from '@shared/protocol/auth-signer';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

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

export interface SmithySigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  /** When temporary credentials stop being valid (not used for signing). */
  expiration?: Date | undefined;
}

/**
 * The single place desktop code builds a `@smithy/signature-v4` signer from
 * explicit, already-resolved credentials. Shared by the HTTP SigV4 auth path
 * and the Kafka AWS MSK IAM token signer.
 */
export function createSmithySignatureV4(
  credentials: SmithySigV4Credentials,
  region: string,
  service: string,
  options: { uriEscapePath?: boolean } = {}
): SignatureV4 {
  return new SignatureV4({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
    region,
    service,
    sha256: Sha256,
    ...(options.uriEscapePath !== undefined ? { uriEscapePath: options.uriEscapePath } : {}),
  });
}

/**
 * HTTP-auth SigV4 on desktop. Must sign exactly what the shared `signSigV4`
 * (web, self-host, CLI) signs: S3 keeps the path as sent, every other service
 * normalises and double-encodes it (smithy's `uriEscapePath`), and the same
 * headers are left unsigned.
 */
export const smithySigV4Signer: SigV4Signer = async (args, creds) => {
  const url = new URL(args.url);

  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] ?? '');
  }

  // `host` (with port) must match the wire Host header the fetcher sends; drop
  // any user-set Host so smithy never sees two differently-cased copies.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.headers)) {
    if (key.toLowerCase() !== 'host') headers[key] = value;
  }
  headers.host = url.host;
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

  const signer = createSmithySignatureV4(
    {
      accessKeyId: creds.accessKey,
      secretAccessKey: creds.secretKey,
      sessionToken: creds.sessionToken,
    },
    creds.region,
    creds.service,
    { uriEscapePath: creds.doubleEncodePath ?? !isS3SigningService(creds.service) }
  );

  const signed = await signer.sign(request, {
    unsignableHeaders: new Set(SIGV4_EXTRA_UNSIGNABLE_HEADERS),
  });

  // Return only the SigV4 contribution; applyAuth merges these onto the request.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    if (typeof value === 'string' && SIGV4_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
};

/**
 * `@smithy/signature-v4` signer for AI provider calls (Bedrock Converse).
 * Supports temporary credentials and, like the AWS SDK, double-encodes the
 * canonical path, which Bedrock model ids containing `:` depend on.
 */
export const smithyAwsRequestSigner: AwsRequestSigner = async (request, credentials) => {
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  const signer = createSmithySignatureV4(
    {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    credentials.region,
    credentials.service
  );
  const signed = await signer.sign(
    new HttpRequest({
      method: request.method,
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      path: url.pathname,
      query,
      headers: { ...request.headers, host: url.host },
      body: request.body,
    }),
    { unsignableHeaders: new Set(SIGV4_EXTRA_UNSIGNABLE_HEADERS) }
  );
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    if (typeof value === 'string' && SIGV4_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
};
