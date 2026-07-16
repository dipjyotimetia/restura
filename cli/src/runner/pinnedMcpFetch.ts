import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  assertResolvedAddressAllowed,
  isCloudMetadataHost,
  isPrivateAddress,
  validateURL,
} from '@shared/protocol/url-validation';
import { Agent, fetch as undiciFetch } from 'undici';

interface PinnedAddress {
  host: string;
  ip: string;
}

/** Resolve and validate the target once; the dispatcher below then dials only this IP. */
export async function resolvePinnedMcpAddress(
  rawUrl: string,
  allowLocalhost: boolean
): Promise<PinnedAddress> {
  const checked = validateURL(rawUrl, { allowLocalhost });
  if (!checked.valid) throw new Error(`MCP transport URL rejected: ${checked.error}`);

  const host = new URL(rawUrl).hostname;
  if (isCloudMetadataHost(host)) {
    throw new Error(`MCP transport URL rejected: cloud metadata endpoint ${host}`);
  }
  if (isIP(host) !== 0) {
    assertResolvedAddressAllowed(host, host, {
      allowLocalhost,
      allowPrivateLiteralHost: isPrivateAddress(host) && allowLocalhost,
      loopbackNeedsLocalhost: true,
    });
    return { host, ip: host };
  }

  const records = await lookup(host, { all: true, verbatim: true });
  if (records.length === 0)
    throw new Error(`MCP transport DNS lookup returned no records: ${host}`);
  // A mixed result is unsafe: the resolver can otherwise choose an internal
  // address after the preflight succeeds with the public one.
  for (const record of records) {
    assertResolvedAddressAllowed(host, record.address, {
      allowLocalhost,
      allowPrivateLiteralHost: false,
      loopbackNeedsLocalhost: true,
    });
  }
  return { host, ip: records[0]!.address };
}

// Node's lookup overloads differ across supported Node versions. The runtime
// contract is the standard (hostname, options-or-callback, callback) shape.
// biome-ignore lint/suspicious/noExplicitAny: Node lookup overload boundary
function createPinnedLookup(host: string, ip: string): any {
  const family = isIP(ip) === 6 ? 6 : 4;
  return (hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown): void => {
    const callback = (
      typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    ) as ((error: Error | null, address: string, family: number) => void) | undefined;
    if (!callback) return;
    if (hostname !== host) {
      callback(new Error(`pinned MCP lookup refused unexpected hostname: ${hostname}`), '', family);
      return;
    }
    callback(null, ip, family);
  };
}

/**
 * DNS-pinned MCP fetch. Redirects are rejected rather than followed, because
 * an SDK-initiated redirect would otherwise need a new validated+ pinned
 * dispatcher. Users must configure the final MCP endpoint directly.
 */
export function createPinnedMcpFetch(allowLocalhost: boolean): typeof globalThis.fetch {
  return (async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const address = await resolvePinnedMcpAddress(rawUrl, allowLocalhost);
    const agent = new Agent({
      connect: { lookup: createPinnedLookup(address.host, address.ip) } as Agent.Options['connect'],
    });
    try {
      const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher: agent,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('MCP transport redirects are not permitted');
      }
      return response as unknown as Response;
    } finally {
      await agent.close();
    }
  }) as typeof globalThis.fetch;
}
