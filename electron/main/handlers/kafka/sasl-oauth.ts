import { fetchClientCredentialsToken } from '@shared/auth/oauth2';
import type { ProtocolSecretValue } from '@shared/protocol/types';
import { validateURL } from '@shared/protocol/url-validation';
import { getExecutionPolicy } from '../../security/execution-policy';
import { createPolicyPinnedFetch, resolvePolicyTransport } from '../../security/policy-transport';
import { resolveSafeAddress } from '../../security/safe-connect';

/**
 * OAuth 2.0 client-credentials token source for Kafka SASL/OAUTHBEARER (#918).
 *
 * `@platformatic/kafka` calls the SASL `token` provider on every
 * (re)authentication — initial connect, each new broker connection, and the
 * KIP-368 re-auth timer it arms from the broker's `sessionLifetimeMs`. The
 * provider below caches the token until `exp - 30s` and fetches a fresh one
 * after that, so long-running consumers re-authenticate with a valid token
 * instead of failing when the first one expires.
 */

/** Refresh this long before the token's expiry. */
export const TOKEN_REFRESH_SKEW_MS = 30_000;
/** Cache lifetime when the IdP gives neither `expires_in` nor a JWT `exp`. */
export const DEFAULT_TOKEN_TTL_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export interface ExpiringToken {
  value: string;
  /** Epoch ms after which the token is no longer valid. */
  expiresAt: number;
}

/**
 * Wrap a token fetcher in a single-flight cache that serves the cached token
 * until `expiresAt - TOKEN_REFRESH_SKEW_MS`. Failures are never cached.
 */
export function createRefreshingTokenProvider(
  fetchToken: () => Promise<ExpiringToken>,
  now: () => number = Date.now
): () => Promise<string> {
  let cached: ExpiringToken | undefined;
  let inflight: Promise<string> | undefined;
  return () => {
    if (cached && now() < cached.expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return Promise.resolve(cached.value);
    }
    inflight ??= fetchToken()
      .then((token) => {
        cached = token;
        return token.value;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

export interface KafkaOAuthClientCredentials {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: ProtocolSecretValue;
  scope?: string | undefined;
}

export interface KafkaOAuthDeps {
  /** Resolve a SecretValue (handle/inline/external) to plaintext — main only. */
  resolveSecret: (value: ProtocolSecretValue) => Promise<string | undefined>;
  /** Build an SSRF-guarded fetch for the token endpoint. */
  guardedFetch?: (url: string) => Promise<typeof globalThis.fetch>;
  now?: () => number;
}

/**
 * SSRF-guarded fetch for an OAuth token endpoint. Runs the shared string-level
 * URL policy, then resolves + validates every DNS record and pins the connect
 * to the validated IP (no rebind window). Redirects are not followed — a 3xx
 * from a token endpoint is treated as a failed token request.
 *
 * Unlike Kafka brokers (which legitimately live on private networks and use the
 * broker guard), the token endpoint is ordinary HTTP and therefore follows the
 * desktop HTTP execution policy: private addresses are rejected unless the user
 * enabled "allow private IPs".
 */
export async function createGuardedTokenFetch(url: string): Promise<typeof globalThis.fetch> {
  const { security } = getExecutionPolicy();
  const checked = validateURL(url, {
    allowedSchemes: ['https:', 'http:'],
    allowLocalhost: security.allowLocalhost,
    allowPrivateIPs: security.allowPrivateIPs,
  });
  if (!checked.valid) {
    throw new Error(`OAuth token endpoint rejected: ${checked.error}`);
  }
  let pinned: Awaited<ReturnType<typeof resolveSafeAddress>>;
  try {
    pinned = await resolveSafeAddress(url, { ...security });
  } catch (err) {
    throw new Error(
      `OAuth token endpoint rejected: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const pinnedFetch = createPolicyPinnedFetch(resolvePolicyTransport({ url }), pinned);
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    pinnedFetch(input, { ...init, redirect: 'manual' })) as typeof globalThis.fetch;
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

function expiresInMs(value: unknown): number | undefined {
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : undefined;
}

/** Fetch one client-credentials token and compute its absolute expiry. */
export async function fetchClientCredentialsExpiringToken(
  config: KafkaOAuthClientCredentials,
  deps: KafkaOAuthDeps
): Promise<ExpiringToken> {
  const now = deps.now ?? Date.now;
  const clientSecret = await deps.resolveSecret(config.clientSecret);
  if (!clientSecret) {
    throw new Error('Kafka OAuth client secret could not be resolved — re-enter it.');
  }
  const fetchImpl = await (deps.guardedFetch ?? createGuardedTokenFetch)(config.tokenEndpoint);
  const requestedAt = now();
  const response = await fetchClientCredentialsToken(
    {
      grantType: 'client_credentials',
      tokenUrl: config.tokenEndpoint,
      clientId: config.clientId,
      clientSecret,
      ...(config.scope ? { scope: config.scope } : {}),
    },
    { fetch: fetchImpl, signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS) }
  );
  if (typeof response.access_token !== 'string' || !response.access_token) {
    throw new Error('OAuth token endpoint response did not include an access_token.');
  }
  const ttl = expiresInMs(response.expires_in);
  const expiresAt =
    ttl !== undefined
      ? requestedAt + ttl
      : (jwtExpiryMs(response.access_token) ?? requestedAt + DEFAULT_TOKEN_TTL_MS);
  return { value: response.access_token, expiresAt };
}

/** Refreshing SASL/OAUTHBEARER token provider for the client-credentials flow. */
export function createClientCredentialsTokenProvider(
  config: KafkaOAuthClientCredentials,
  deps: KafkaOAuthDeps
): () => Promise<string> {
  return createRefreshingTokenProvider(
    () => fetchClientCredentialsExpiringToken(config, deps),
    deps.now
  );
}
