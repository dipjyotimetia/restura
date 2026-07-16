import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  assertResolvedAddressAllowed,
  isCloudMetadataHost,
  isPrivateAddress,
  validateURL,
} from '@shared/protocol/url-validation';
import type { Fetcher } from '@shared/protocol/types';
import { Agent, fetch as undiciFetch } from 'undici';
import { createUndiciFetcher } from './undiciFetcher.js';

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

export interface PinnedFetchSession {
  fetch: typeof globalThis.fetch;
  /** DNS-pinned equivalent for the shared HTTP protocol executor. */
  fetcher: Fetcher;
  /** Ends all requests owned by this short-lived agent/MCP session. */
  dispose(): Promise<void>;
}

function configuredProxyEnvironment(): string | undefined {
  return ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'].find((name) =>
    Boolean(process.env[name])
  );
}

function createPinnedAgent(address: PinnedAddress): Agent {
  return new Agent({
    connect: { lookup: createPinnedLookup(address.host, address.ip) } as Agent.Options['connect'],
  });
}

/**
 * DNS-pinned MCP fetch. Redirects are rejected rather than followed, because
 * an SDK-initiated redirect would otherwise need a new validated+ pinned
 * dispatcher. Users must configure the final MCP endpoint directly.
 */
export function createPinnedMcpFetchSession(allowLocalhost: boolean): PinnedFetchSession {
  const proxyVariable = configuredProxyEnvironment();
  if (proxyVariable) {
    throw new Error(
      `agent network tools cannot run with ${proxyVariable}: DNS-pinned direct transport ` +
        'does not support HTTP proxying; unset the proxy for this run'
    );
  }
  const agents = new Set<Agent>();
  let disposed = false;

  const agentFor = async (rawUrl: string): Promise<Agent> => {
    if (disposed) throw new DOMException('pinned fetch session disposed', 'AbortError');
    const address = await resolvePinnedMcpAddress(rawUrl, allowLocalhost);
    if (disposed) throw new DOMException('pinned fetch session disposed', 'AbortError');
    const agent = createPinnedAgent(address);
    if (disposed) {
      agent.destroy();
      throw new DOMException('pinned fetch session disposed', 'AbortError');
    }
    agents.add(agent);
    return agent;
  };

  const fetch = (async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: await agentFor(rawUrl),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('MCP transport redirects are not permitted');
    }
    return response as unknown as Response;
  }) as typeof globalThis.fetch;

  return {
    fetch,
    fetcher: async (request) => createUndiciFetcher(await agentFor(request.url))(request),
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const agent of agents) agent.destroy();
      agents.clear();
    },
  };
}
