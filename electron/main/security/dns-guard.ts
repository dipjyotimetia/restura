import type { LookupAddress } from 'node:dns';
import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import {
  assertResolvedAddressAllowed,
  isPrivateAddress,
  validateURL,
} from '@shared/protocol/url-validation';

// Pre-flight SSRF guard for transports that don't accept a connector-level
// `lookup` hook (native fetch, ws, socket.io-client). Best-effort against
// true DNS-rebind (TTL=0 swap between this lookup and the actual connect)
// — full protection requires a custom dispatcher per transport.
export interface DnsGuardOptions {
  allowLocalhost: boolean;
  /**
   * Permit RFC-1918 / CGNAT / link-local targets (literal or DNS-resolved).
   * Off by default; sourced from the Settings → Security network policy.
   * Cloud-metadata endpoints stay blocked regardless.
   */
  allowPrivateIPs?: boolean;
  /**
   * Schemes accepted by the calling transport. Defaults to http/https; the
   * websocket and socket.io handlers override with ws/wss variants so the
   * shared URL policy ({@link validateURL}) doesn't reject their URLs as
   * the "wrong" scheme up front.
   */
  allowedSchemes?: string[];
}

export async function assertHostnameSafe(
  hostname: string,
  options: DnsGuardOptions
): Promise<LookupAddress[]> {
  if (net.isIP(hostname) !== 0) {
    assertResolvedAddressAllowed(hostname, hostname, {
      allowLocalhost: options.allowLocalhost,
      allowPrivateLiteralHost: isPrivateAddress(hostname),
      // Desktop keeps localhost + private-IP as independent Security toggles, so
      // loopback is gated on allowLocalhost even when private IPs are allowed.
      loopbackNeedsLocalhost: true,
    });
    return [{ address: hostname, family: net.isIP(hostname) === 6 ? 6 : 4 }];
  }

  let records: LookupAddress[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(
      `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  for (const r of records) {
    assertResolvedAddressAllowed(hostname, r.address, {
      allowLocalhost: options.allowLocalhost,
      // Honour the private-IP opt-in for DNS-resolved addresses too, so a
      // hostname pointing at an RFC-1918 target is permitted only when the
      // policy allows it. Cloud-metadata stays blocked inside the assertion.
      allowPrivateLiteralHost: options.allowPrivateIPs === true,
      // Loopback stays gated on allowLocalhost — allow-private-IPs must not
      // re-open a hostname that resolves to 127.0.0.1/::1.
      loopbackNeedsLocalhost: true,
    });
  }
  return records;
}

/**
 * Apply both the shared URL-string policy (`validateURL`: scheme, length,
 * blocked hostnames, literal-IP rules) and the DNS-resolved-address policy
 * to a URL string. Throws on any violation.
 */
export async function assertUrlHostnameSafe(url: string, options: DnsGuardOptions): Promise<void> {
  const v = validateURL(url, {
    allowLocalhost: options.allowLocalhost,
    allowPrivateIPs: options.allowPrivateIPs === true,
    ...(options.allowedSchemes ? { allowedSchemes: options.allowedSchemes } : {}),
  });
  if (!v.valid) {
    throw new Error(v.error ?? `URL rejected by policy: ${url}`);
  }
  await assertHostnameSafe(new URL(url).hostname, options);
}

/**
 * Resolve + validate in one call, returning the records so callers can pin
 * an IP without a second `dns.lookup`. Used by `safe-connect.ts`.
 */
export async function resolveUrlHostnameSafe(
  url: string,
  options: DnsGuardOptions
): Promise<LookupAddress[]> {
  const v = validateURL(url, {
    allowLocalhost: options.allowLocalhost,
    allowPrivateIPs: options.allowPrivateIPs === true,
    ...(options.allowedSchemes ? { allowedSchemes: options.allowedSchemes } : {}),
  });
  if (!v.valid) {
    throw new Error(v.error ?? `URL rejected by policy: ${url}`);
  }
  return assertHostnameSafe(new URL(url).hostname, options);
}
