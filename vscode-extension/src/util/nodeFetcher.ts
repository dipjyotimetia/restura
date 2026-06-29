import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Fetcher } from '../../../shared/protocol/types';
import { assertResolvedAddressAllowed } from '../../../shared/protocol/url-validation';

export interface NodeFetcherOptions {
  allowLocalhost: boolean;
  allowPrivateIPs: boolean;
}

/**
 * Pre-flight SSRF guard for hostNAME targets: resolve the host and reject if any
 * record points at a private / loopback / cloud-metadata address (unless the
 * settings explicitly permit it). Literal-IP hosts are left to `validateURL`
 * (which already ran in `executeHttpProxy`), so the loopback/literal carve-outs
 * there aren't double-enforced here.
 *
 * This mirrors Electron's pre-flight `dns-guard`. Like that guard it does NOT
 * defend against a true DNS-rebind (TTL=0 swap between this check and connect) —
 * global `fetch` re-resolves at connect time — but it closes the static
 * name→private-address window that bare `fetch` would otherwise leave open.
 */
export async function assertHostSafe(rawUrl: string, opts: NodeFetcherOptions): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return; // executeHttpProxy's validateURL already rejects unparseable URLs
  }
  if (hostname === '' || isIP(hostname) !== 0) return; // literal IPs handled by validateURL

  const records = await lookup(hostname, { all: true });
  for (const { address } of records) {
    assertResolvedAddressAllowed(hostname, address, {
      allowLocalhost: opts.allowLocalhost,
      allowPrivateLiteralHost: opts.allowPrivateIPs,
    });
  }
}

/**
 * Build a `Fetcher` for the VS Code Node extension host — the "4th backend" in
 * Restura's one-renderer-N-backends model. Uses the host's global `fetch`
 * (Node ≥ 18) with `redirect: 'manual'` so the shared redirect-follower owns
 * redirect policy; because the follower reuses this fetcher per hop, the DNS
 * guard runs on every redirect target too.
 */
export function createNodeFetcher(opts: NodeFetcherOptions): Fetcher {
  return async (req) => {
    await assertHostSafe(req.url, opts);
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: req.body,
      signal: req.signal,
      redirect: 'manual',
    });
    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text: () => res.text(),
      arrayBuffer: () => res.arrayBuffer(),
      contentLengthHeader: res.headers.get('content-length'),
      body: res.body,
    };
  };
}
