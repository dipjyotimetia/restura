import { HttpRequest } from '@smithy/protocol-http';
import {
  createSmithySignatureV4,
  type SmithySigV4Credentials,
} from '../../security/aws-sigv4-smithy';
import {
  createRefreshingTokenProvider,
  type ExpiringToken,
  TOKEN_REFRESH_SKEW_MS,
} from './sasl-oauth';

/**
 * AWS MSK IAM authentication (#918).
 *
 * `@platformatic/kafka` only negotiates the standard SASL mechanisms, so MSK IAM
 * uses MSK's SASL/OAUTHBEARER variant: the bearer token is a SigV4-presigned
 * `kafka-cluster:Connect` URL, base64url-encoded without padding — the same
 * wire format produced by AWS's official `aws-msk-iam-sasl-signer-*` libraries.
 * Brokers must expose the IAM listener with SASL/OAUTHBEARER enabled (MSK does
 * on the `SASL_SSL` IAM port, 9098).
 */

export const MSK_IAM_TOKEN_TTL_SECONDS = 900;
export const MSK_IAM_USER_AGENT = 'restura-msk-iam-sasl-signer/1.0';
const MSK_IAM_SERVICE = 'kafka-cluster';
const MSK_IAM_ACTION = 'kafka-cluster:Connect';

function formatQuery(query: Record<string, string | string[] | null>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (raw === null) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}

/** Sign one MSK IAM OAUTHBEARER token at `nowMs` with explicit credentials. */
export async function generateMskIamToken(
  region: string,
  credentials: SmithySigV4Credentials,
  nowMs: number
): Promise<ExpiringToken> {
  const hostname = `kafka.${region}.amazonaws.com`;
  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname,
    path: '/',
    headers: { host: hostname },
    query: { Action: MSK_IAM_ACTION },
  });
  const signer = createSmithySignatureV4(credentials, region, MSK_IAM_SERVICE);
  const signed = await signer.presign(request, {
    expiresIn: MSK_IAM_TOKEN_TTL_SECONDS,
    signingDate: new Date(nowMs),
  });
  const query = { ...(signed.query as Record<string, string | string[] | null>) };
  // Not part of the signature — appended after signing, as the AWS signers do.
  query['User-Agent'] = MSK_IAM_USER_AGENT;
  const url = `https://${hostname}/?${formatQuery(query)}`;
  // The presigned URL is valid for 15 minutes, but never past the temporary
  // credentials' own expiry (minus the refresh skew).
  const urlExpiry = nowMs + MSK_IAM_TOKEN_TTL_SECONDS * 1000;
  const credentialExpiry = credentials.expiration
    ? credentials.expiration.getTime() - TOKEN_REFRESH_SKEW_MS
    : Number.POSITIVE_INFINITY;
  return {
    value: Buffer.from(url, 'utf8').toString('base64url'),
    expiresAt: Math.min(urlExpiry, credentialExpiry),
  };
}

/**
 * Refreshing SASL/OAUTHBEARER token provider for MSK IAM. Credentials are
 * re-loaded on every refresh so rotated profile/session credentials apply.
 */
export function createMskIamTokenProvider(
  region: string,
  loadCredentials: () => Promise<SmithySigV4Credentials>,
  now: () => number = Date.now
): () => Promise<string> {
  return createRefreshingTokenProvider(
    async () => generateMskIamToken(region, await loadCredentials(), now()),
    now
  );
}
