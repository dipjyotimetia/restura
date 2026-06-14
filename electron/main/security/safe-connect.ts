/**
 * DNS-pinning helper (Gap #4). Solves the TTL=0 rebind window that
 * `assertUrlHostnameSafe` alone can't close: resolve once, validate every
 * returned record, then hand callers a pre-pinned IP + a Node `lookup`
 * function that always returns it.
 *
 * Callers must pass `servername`/`host` separately so SNI + Host header still
 * point at the original hostname (TLS certificate validation + HTTP routing).
 *
 * For transports with a Node `lookup` hook (undici, `ws`, `http.request`),
 * `createPinnedLookup(host, ip)` is a drop-in. For fetch-based handlers,
 * `createPinnedFetch(host, ip)` wraps undici with the same lookup hook so the
 * underlying connect uses the pinned IP regardless of TTL.
 *
 * gRPC (`@grpc/grpc-js`) has no Node `lookup` hook, but `grpc-handler.ts` pins
 * it a different way: it resolves+validates here and dials the IP literal with
 * `grpc.default_authority` / `grpc.ssl_target_name_override` set to the original
 * host (see `computeGrpcDial`). Kafka (`@platformatic/kafka`) resolves inside its
 * C++ binding and still gets `assertUrlHostnameSafe()` immediately before connect
 * (narrowing the rebind window) but isn't fully pinned. See ADR-0006.
 */

import * as dns from 'node:dns';
import * as net from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { assertHostnameSafe, type DnsGuardOptions } from './dns-guard';
import { assertResolvedAddressAllowed, isPrivateAddress } from '@shared/protocol/url-validation';
import type { LookupAddress } from 'node:dns';

export interface SafeAddress {
  /** The original hostname — keep using this for SNI + Host header. */
  host: string;
  /** The validated IPv4 or IPv6 literal the connector should dial. */
  ip: string;
  port: number;
  family: 4 | 6;
}

export interface ResolveOptions extends DnsGuardOptions {
  /** Default port for the scheme (80 / 443) when the URL omits it. */
  defaultPort?: number;
}

/**
 * Resolve a URL once, validate every returned record via the shared SSRF
 * policy, return the first allowed address. Throws if no record passes.
 */
export async function resolveSafeAddress(
  url: string,
  options: ResolveOptions
): Promise<SafeAddress> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : (options.defaultPort ??
      (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80));

  // Literal IPs short-circuit DNS entirely. Validate per the shared policy
  // (the same call assertHostnameSafe makes internally).
  if (net.isIP(host) !== 0) {
    assertResolvedAddressAllowed(host, host, {
      allowLocalhost: options.allowLocalhost,
      allowPrivateLiteralHost: isPrivateAddress(host),
    });
    return { host, ip: host, port, family: net.isIP(host) === 6 ? 6 : 4 };
  }

  const records: LookupAddress[] = await assertHostnameSafe(host, options);
  if (records.length === 0) {
    throw new Error(`DNS resolution returned no records for ${host}`);
  }
  const chosen = records[0]!;
  return {
    host,
    ip: chosen.address,
    port,
    family: chosen.family === 6 ? 6 : 4,
  };
}

/**
 * Node-compatible `lookup` function that always returns the pinned IP.
 * Suitable for `undici.Agent({ connect: { lookup } })` and Node `net`/`tls`
 * connect options.
 *
 * Type-erased via `any` at the boundary because Node's `dns.LookupFunction`
 * signature varies subtly across Node versions and is overloaded in ways
 * TypeScript can't satisfy from a single arrow function body. The runtime
 * contract (hostname, options-or-cb, cb) matches every supported version.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPinnedLookup(host: string, ip: string): any {
  const family: 4 | 6 = net.isIP(ip) === 6 ? 6 : 4;
  return (hostname: string, optsOrCb: unknown, maybeCb?: unknown): void => {
    const callback = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
      | ((
          err: NodeJS.ErrnoException | null,
          address: string | Array<{ address: string; family: number }>,
          family?: number
        ) => void)
      | undefined;
    const lookupOptions = (
      typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb : {}
    ) as dns.LookupOptions;
    if (!callback) return;
    if (hostname !== host) {
      // Pass through to the system resolver for any unexpected hostname.
      // Use the simple `{all: false}` form — Node's dns.lookup overloads
      // are TS-unfriendly across versions, so route through an inline cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dns.lookup as any)(hostname, lookupOptions, callback);
      return;
    }
    if (lookupOptions.all) {
      callback(null, [{ address: ip, family }], family);
      return;
    }
    callback(null, ip, family);
  };
}

/**
 * Pinned-fetch wrapper: same signature as native fetch, but the underlying
 * undici dispatcher uses a `lookup` hook that always returns `ip` for `host`.
 * SNI + Host header continue to use `host` (preserves TLS validation).
 */
export function createPinnedFetch(host: string, ip: string): typeof globalThis.fetch {
  const agent = new Agent({
    connect: { lookup: createPinnedLookup(host, ip) },
  });
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const undiciInit: UndiciRequestInit = {
      ...(init as UndiciRequestInit | undefined),
      dispatcher: agent,
    } as UndiciRequestInit;
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      undiciInit
    ) as unknown as Promise<Response>;
  }) as typeof globalThis.fetch;
}
