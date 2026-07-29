import type { Fetcher, FetcherResponse } from '@shared/protocol/types';
import { session } from 'electron';
import { assertProxyTargetUrlSafe } from '../security/dns-guard';
import {
  applyManagedTransportPolicy,
  resolveManagedProxyForUrl,
} from '../security/enterprise-network';
import {
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
} from '../security/managed-enterprise-policy';
import { createPolicyPinnedFetch, type PolicyTransportConfig } from '../security/policy-transport';
import { createPinnedFetch, resolveSafeAddress } from '../security/safe-connect';

/**
 * Resolve transport state from the URL supplied by the shared redirect
 * follower. Managed PAC, bypass, TLS, and DNS pinning decisions are
 * destination-specific, so a transport selected for the first hop must never
 * be reused for a later origin.
 */
export function makeRouteAwareFetcher(createFetcher: (url: string) => Promise<Fetcher>): Fetcher {
  return async (request) => {
    const fetcher = await createFetcher(request.url);
    return fetcher(request);
  };
}

/**
 * Build a Node-`fetch`-backed {@link Fetcher} adapter mapping native `fetch`
 * to the shared protocol's {@link FetcherResponse} shape.
 *
 * Several Electron streaming handlers (SSE, AI chat) need the identical thin
 * wrapper; this is the single source so the response mapping evolves in one
 * place. Distinct from the HTTP handler's heavyweight fetcher (mTLS / SOCKS /
 * PAC) — this is the minimal variant for handlers that just need plain fetch.
 *
 * `redirect`: handlers that run through the shared redirect-follower (which
 * SSRF-validates every hop) pass `'manual'`; callers that don't pass the
 * default `'follow'`.
 *
 * `fetchImpl`: defaults to the global `fetch`. SSRF-sensitive handlers pass a
 * DNS-pinned fetch (`createPinnedFetch` from safe-connect.ts) so the connect
 * dials the IP we already validated rather than a freshly-resolved (possibly
 * rebound) address.
 */
export function makeFetchFetcher(
  options: { redirect?: RequestRedirect; fetchImpl?: typeof globalThis.fetch } = {}
): Fetcher {
  const { redirect = 'follow', fetchImpl = fetch } = options;
  return async (req) => {
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: req.body,
      signal: req.signal,
      redirect,
    });
    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body: res.body,
      contentLengthHeader: res.headers.get('content-length'),
      text: () => res.text(),
    } satisfies FetcherResponse;
  };
}

/**
 * Build a {@link Fetcher} pinned to a once-resolved, SSRF-validated IP for `url`:
 * resolve + validate the host (per `allowLocalhost`), then dial that exact IP with
 * `redirect: 'manual'` so a 3xx can't bounce to a private/metadata host and the
 * DNS-rebind window stays closed. Throws on any policy violation.
 *
 * `allowLocalhost` is the caller's policy and is intentionally required (no
 * default): cloud-only callers pass `false`; local-runtime callers derive it per
 * provider. Shared by the AI chat + AI Lab handlers so the SSRF/redirect wire
 * mechanics live in one place.
 */
export async function makePinnedFetcher(
  url: string,
  options: {
    allowLocalhost: boolean;
    managedTransport?: Omit<PolicyTransportConfig, 'url' | 'proxy'>;
  }
): Promise<Fetcher> {
  const managed = getManagedEnterprisePolicy();
  if (managed.status.state === 'unmanaged') {
    const pinned = await resolveSafeAddress(url, { allowLocalhost: options.allowLocalhost });
    return makeFetchFetcher({
      redirect: 'manual',
      fetchImpl: createPinnedFetch(pinned.host, pinned.ip),
    });
  }

  return makeRouteAwareFetcher(async (destination) => {
    const proxyTargetPolicy = { allowLocalhost: options.allowLocalhost };
    assertProxyTargetUrlSafe(destination, proxyTargetPolicy);
    const proxy = await resolveManagedProxyForUrl(destination, session.defaultSession, managed);
    const pinned =
      proxy?.type === 'http' || proxy?.type === 'https' || proxy?.resolution
        ? undefined
        : await resolveSafeAddress(destination, {
            allowLocalhost: options.allowLocalhost,
          });
    const transport = applyManagedTransportPolicy(
      {
        ...(options.managedTransport ?? {}),
        url: destination,
        proxy,
        proxyTargetPolicy,
        verifySsl: true,
      },
      managed,
      getManagedCaCertificateBundle()
    );
    return makeFetchFetcher({
      redirect: 'manual',
      fetchImpl: createPolicyPinnedFetch(transport, pinned),
    });
  });
}

/**
 * Fetch implementation for SDKs that own their request lifecycle (MCP). Each
 * invocation receives a fresh DNS pin and managed route. Redirects remain
 * manual so an SDK cannot follow a second URL behind this policy boundary.
 */
export function makeManagedRouteAwareFetch(
  baseConfig: Omit<PolicyTransportConfig, 'url' | 'proxy'>,
  options: { allowLocalhost: boolean }
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const destination =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const managed = getManagedEnterprisePolicy();
    const proxyTargetPolicy = { allowLocalhost: options.allowLocalhost };
    assertProxyTargetUrlSafe(destination, proxyTargetPolicy);
    const proxy = await resolveManagedProxyForUrl(destination, session.defaultSession, managed);
    const pinned =
      proxy?.type === 'http' || proxy?.type === 'https' || proxy?.resolution
        ? undefined
        : await resolveSafeAddress(destination, {
            allowLocalhost: options.allowLocalhost,
          });
    const transport = applyManagedTransportPolicy(
      { ...baseConfig, url: destination, proxy, proxyTargetPolicy, verifySsl: true },
      managed,
      getManagedCaCertificateBundle()
    );
    return createPolicyPinnedFetch(transport, pinned)(input, {
      ...init,
      redirect: 'manual',
    });
  }) as typeof globalThis.fetch;
}
