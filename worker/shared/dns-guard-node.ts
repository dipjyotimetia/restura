/**
 * Pre-flight DNS-resolution SSRF guard for the Node Worker. The Cloudflare
 * runtime refuses connects to RFC 1918 / link-local / loopback / metadata
 * addresses implicitly; in Node we have to resolve the hostname ourselves
 * and check every record before dialing.
 *
 * Best-effort against DNS rebind — a TTL=0 swap between this lookup and the
 * subsequent `net.connect()` / `tls.connect()` / `new WebSocket(...)` is
 * still possible. Full mitigation requires a custom dispatcher per transport
 * (Electron uses `safe-connect.ts`). Worth doing here as a layered defence,
 * given the Cloudflare path doesn't even need this.
 */
import * as dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import * as net from 'node:net';
import { assertResolvedAddressAllowed, isPrivateAddress } from '@shared/protocol/url-validation';

export interface DnsGuardOptions {
  /** Permit localhost / 127.0.0.1 / ::1 — typically only on `ENVIRONMENT=development`. */
  allowLocalhost?: boolean;
  /**
   * Permit any private address (RFC 1918 / link-local / CGNAT / IPv6 ULA).
   * Self-hosted enterprises set this via `ALLOW_PRIVATE_IPS=true` so they
   * can reach internal services. Cloud-metadata endpoints stay hard-blocked
   * regardless (see `assertResolvedAddressAllowed`).
   */
  allowPrivateIPs?: boolean;
}

/**
 * Resolve `hostname` and assert every returned address is permitted by the
 * shared SSRF policy. If the hostname is a literal IP, no DNS lookup happens
 * — `assertResolvedAddressAllowed` is called directly.
 */
export async function assertNodeHostnameSafe(
  hostname: string,
  options: DnsGuardOptions = {}
): Promise<LookupAddress[]> {
  const allowLocalhost = options.allowLocalhost === true;
  const allowPrivateLiteralHost = options.allowPrivateIPs === true;

  if (net.isIP(hostname) !== 0) {
    assertResolvedAddressAllowed(hostname, hostname, {
      allowLocalhost,
      allowPrivateLiteralHost: allowPrivateLiteralHost || isPrivateAddress(hostname),
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
      allowLocalhost,
      // The user typed a hostname (not a literal IP), so we don't grant the
      // "user explicitly typed a private IP" exemption here. ALLOW_PRIVATE_IPS
      // grants it instead.
      allowPrivateLiteralHost,
    });
  }
  return records;
}
