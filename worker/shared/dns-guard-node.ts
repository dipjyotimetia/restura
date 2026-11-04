/**
 * DNS-resolution SSRF guard for the Node Worker. The Cloudflare runtime
 * refuses connects to RFC 1918 / link-local / loopback / metadata addresses
 * implicitly; in Node we have to resolve the hostname ourselves and check
 * every record before dialing.
 *
 * A pre-flight check alone is open to DNS rebinding (a TTL=0 swap between the
 * check and the dial's own re-resolution), so every dial must use the
 * address(es) validated here: `createGuardedLookup` is a `net`/`tls`/undici
 * `lookup` that resolves AND validates at connect time (used by
 * `guarded-fetch-node.ts`), and the raw-socket / WebSocket transports dial
 * the returned address directly.
 */
import type { LookupAddress } from 'node:dns';
import * as dns from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import * as net from 'node:net';
import { assertResolvedAddressAllowed, isCloudMetadataHost } from '@shared/protocol/url-validation';

export interface NodeDnsGuardOptions {
  /** Permit localhost / 127.0.0.1 / ::1 — typically only on `ENVIRONMENT=development`. */
  allowLocalhost?: boolean;
  /**
   * Permit any private address (RFC 1918 / link-local / CGNAT / IPv6 ULA).
   * Self-hosted enterprises set this via `ALLOW_PRIVATE_IPS=true` so they
   * can reach internal services. Cloud-metadata / credential endpoints stay
   * hard-blocked regardless (`isCloudMetadataHost`), and loopback is opened
   * only by `allowLocalhost` — for literals and DNS-resolved names alike, the
   * same as `validateURL`.
   */
  allowPrivateIPs?: boolean;
}

/**
 * Resolve `hostname` and assert every returned address is permitted by the
 * shared SSRF policy. If the hostname is a literal IP, no DNS lookup happens
 * — `assertResolvedAddressAllowed` is called directly.
 *
 * Policy: the `allowPrivateIPs` option is the SINGLE switch that decides
 * whether private addresses (literal-typed or DNS-resolved) are permitted.
 * We deliberately do NOT auto-grant the "user explicitly typed a private IP"
 * exemption — that path exists in Electron because users there configure
 * lab/internal targets directly, but in the Worker every URL goes through
 * the SSRF gate AND the operator's deployment-level toggle. Consistent
 * behaviour avoids the previous footgun where a literal private IP bypassed
 * the gate even when ALLOW_PRIVATE_IPS=false.
 */
export async function assertNodeHostnameSafe(
  hostname: string,
  options: NodeDnsGuardOptions = {}
): Promise<LookupAddress[]> {
  const allowLocalhost = options.allowLocalhost === true;
  const allowPrivateLiteralHost = options.allowPrivateIPs === true;

  // Callers pass `new URL(u).hostname`, which keeps the brackets on IPv6
  // literals (`[2606:4700::1111]`). `net.isIP` returns 0 for the bracketed
  // form, which used to send every IPv6 literal to `dns.lookup` → ENOTFOUND.
  // Classify (and return) the bare address so the private-IP policy and any
  // pinned connect see the real literal.
  const literal = /^\[.*\]$/.test(hostname) ? hostname.slice(1, -1) : hostname;
  const literalFamily = net.isIP(literal);
  if (literalFamily !== 0) {
    if (isCloudMetadataHost(literal)) {
      throw new Error(`Hostname ${literal} is hard-blocked (cloud-metadata endpoint)`);
    }
    assertResolvedAddressAllowed(literal, literal, {
      allowLocalhost,
      allowPrivateLiteralHost,
      loopbackNeedsLocalhost: true,
    });
    return [{ address: literal, family: literalFamily === 6 ? 6 : 4 }];
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
    if (isCloudMetadataHost(r.address)) {
      throw new Error(
        `DNS resolution for ${hostname} returned hard-blocked address ${r.address} (cloud-metadata endpoint)`
      );
    }
    assertResolvedAddressAllowed(hostname, r.address, {
      allowLocalhost,
      allowPrivateLiteralHost,
      loopbackNeedsLocalhost: true,
    });
  }
  return records;
}

/**
 * A `net.connect` / `tls.connect` / undici `connect.lookup` that resolves the
 * name through {@link assertNodeHostnameSafe} and hands the dial only the
 * addresses that passed. Resolution and validation happen in the same step
 * the socket uses, so there is no window for a rebind between them. Errors
 * are tagged so callers can surface the guard's message instead of a generic
 * "fetch failed" (see {@link isNodeDnsGuardError}).
 */
export function createGuardedLookup(options: NodeDnsGuardOptions = {}): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    assertNodeHostnameSafe(hostname, options).then(
      (records) => {
        const family = lookupOptions.family;
        const wanted =
          family === 4 || family === 6 ? records.filter((r) => r.family === family) : records;
        const first = wanted[0];
        if (!first) {
          const err = guardError(
            new Error(`DNS lookup for ${hostname} returned no usable address`)
          );
          callback(err as NodeJS.ErrnoException, '', 4);
          return;
        }
        if (lookupOptions.all) callback(null, wanted);
        else callback(null, first.address, first.family);
      },
      (err: unknown) => {
        callback(guardError(err) as NodeJS.ErrnoException, '', 4);
      }
    );
  };
}

const GUARD_ERRORS = new WeakSet<Error>();

function guardError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  GUARD_ERRORS.add(e);
  return e;
}

/** True for an error raised by {@link createGuardedLookup}'s SSRF check. */
export function isNodeDnsGuardError(err: unknown): err is Error {
  return err instanceof Error && GUARD_ERRORS.has(err);
}
