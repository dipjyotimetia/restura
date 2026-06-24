/**
 * DNS-pinning helper. Solves the TTL=0 rebind window that
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

// eslint-disable-next-line import/no-duplicates -- namespace + named type imports from 'node:dns' can't be merged into a single statement
import type * as dns from 'node:dns';
// eslint-disable-next-line import/no-duplicates -- see above
import type { LookupAddress } from 'node:dns';
import * as net from 'node:net';
import {
  assertResolvedAddressAllowed,
  isCloudMetadataHost,
  isPrivateAddress,
} from '@shared/protocol/url-validation';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { assertHostnameSafe, type DnsGuardOptions } from './dns-guard';

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
 * policy (any disallowed record throws), then return the first record.
 * Fails closed: a single bad record rejects the whole resolution rather
 * than silently picking a passing sibling.
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

  // Cloud-metadata endpoints are never a legitimate target — block them up front
  // even for transports that allow private IPs (ws/socket.io/mcp), since those
  // paths don't run the string-level `validateURL` policy.
  if (isCloudMetadataHost(host)) {
    throw new Error(`Refusing to connect to cloud metadata endpoint: ${host}`);
  }

  // Literal IPs short-circuit DNS entirely. Validate per the shared policy
  // (the same call assertHostnameSafe makes internally). The literal-host
  // carve-out for private addresses applies ONLY when the caller permits
  // localhost (local AI runtimes, user-typed lab targets) — a cloud caller
  // passing `allowLocalhost:false` must not reach an RFC1918/loopback literal.
  if (net.isIP(host) !== 0) {
    assertResolvedAddressAllowed(host, host, {
      allowLocalhost: options.allowLocalhost,
      allowPrivateLiteralHost: options.allowLocalhost === true && isPrivateAddress(host),
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
      // A pinned connection must never resolve a hostname other than the one we
      // validated. The only way this fires is a handshake/HTTP 3xx redirect to a
      // different host (ws `followRedirects`, undici default redirect) — passing
      // it through to the system resolver would reach an unvalidated, possibly
      // internal/metadata target. Fail closed.
      callback(
        new Error(`pinned lookup refused unexpected hostname "${hostname}" (pinned to "${host}")`),
        '',
        family
      );
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
