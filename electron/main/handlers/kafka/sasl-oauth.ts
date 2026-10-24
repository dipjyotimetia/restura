import { fetchClientCredentialsToken } from '@shared/auth/oauth2';
import { isPlaintextTokenEndpointAllowed } from '@shared/protocol/kafka-sasl-policy';
import type { ProtocolSecretValue } from '@shared/protocol/types';
import { validateURL } from '@shared/protocol/url-validation';
import { getExecutionPolicy } from '../../security/execution-policy';
import {
  createClosablePolicyPinnedFetch,
  resolvePolicyTransport,
} from '../../security/policy-transport';
import { resolveSafeAddress } from '../../security/safe-connect';

/**
 * OAuth 2.0 client-credentials token source for Kafka SASL/OAUTHBEARER (#918).
 *
 * `@platformatic/kafka` calls the SASL `token` provider on every
 * (re)authentication — initial connect, each new broker connection, and the
 * KIP-368 re-auth timer it arms from the broker's `sessionLifetimeMs`. The
 * provider below caches the token until less than max(30s, 25% of its
 * lifetime) remains and fetches a fresh one after that, so the library's
 * re-auth (at 0.8 x session lifetime) presents a new token.
 */

/** Minimum refresh lead: never present a token with less than 30s left. */
export const TOKEN_REFRESH_SKEW_MS = 30_000;
/**
 * Proportional refresh lead. `@platformatic/kafka` re-authenticates at 0.8 x the
 * broker's session lifetime (which tracks the token lifetime), so refreshing
 * once less than 25% of the lifetime remains guarantees that re-auth presents a
 * NEW token rather than the one about to expire.
 */
export const TOKEN_REFRESH_FRACTION = 0.25;
/** Cache lifetime when the IdP gives neither `expires_in` nor a JWT `exp`. */
export const DEFAULT_TOKEN_TTL_MS = 60_000;
/** Upper bound on a token endpoint response body. */
export const TOKEN_RESPONSE_MAX_BYTES = 1024 * 1024;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** How long before expiry a token with lifetime `ttlMs` is refreshed. */
export function refreshLeadMs(ttlMs: number): number {
  return Math.max(TOKEN_REFRESH_SKEW_MS, TOKEN_REFRESH_FRACTION * Math.max(0, ttlMs));
}

export interface ExpiringToken {
  value: string;
  /** Epoch ms after which the token is no longer valid. */
  expiresAt: number;
}

/**
 * Wrap a token fetcher in a single-flight cache that serves the cached token
 * until less than {@link refreshLeadMs} of its lifetime remains. Failures are
 * never cached.
 */
export function createRefreshingTokenProvider(
  fetchToken: () => Promise<ExpiringToken>,
  now: () => number = Date.now
): () => Promise<string> {
  let cached: { token: ExpiringToken; refreshAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  return () => {
    if (cached && now() < cached.refreshAt) {
      return Promise.resolve(cached.token.value);
    }
    inflight ??= fetchToken()
      .then((token) => {
        const fetchedAt = now();
        cached = {
          token,
          refreshAt: token.expiresAt - refreshLeadMs(token.expiresAt - fetchedAt),
        };
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
  /** Resolve a SecretValue (kafka-scoped handle / inline) to plaintext — main only. */
  resolveSecret: (value: ProtocolSecretValue) => Promise<string | undefined>;
  /** Build an SSRF-guarded fetch for the token endpoint. */
  guardedFetch?: (url: string) => Promise<GuardedTokenFetch>;
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
export type GuardedTokenFetch = typeof globalThis.fetch & {
  /** Release the per-request connection pool once the token request is done. */
  close?: () => Promise<void>;
};

export async function createGuardedTokenFetch(url: string): Promise<GuardedTokenFetch> {
  if (!isPlaintextTokenEndpointAllowed(url)) {
    throw new Error(
      'OAuth token endpoint rejected: https is required (http is allowed only for loopback or private IP hosts)'
    );
  }
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
  const closable = createClosablePolicyPinnedFetch(resolvePolicyTransport({ url }), pinned);
  const guarded = ((input: RequestInfo | URL, init?: RequestInit) =>
    closable.fetch(input, { ...init, redirect: 'manual' })) as GuardedTokenFetch;
  guarded.close = closable.close;
  return guarded;
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
  let response: Awaited<ReturnType<typeof fetchClientCredentialsToken>>;
  try {
    response = await fetchClientCredentialsToken(
      {
        grantType: 'client_credentials',
        tokenUrl: config.tokenEndpoint,
        clientId: config.clientId,
        clientSecret,
        ...(config.scope ? { scope: config.scope } : {}),
      },
      {
        fetch: fetchImpl,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        maxResponseBytes: TOKEN_RESPONSE_MAX_BYTES,
      }
    );
  } finally {
    await fetchImpl.close?.().catch(() => undefined);
  }
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
