/**
 * DNS-pinned upstream fetch for the self-host Node server (never bundled into
 * the Cloudflare Worker: only `node-entry.ts` imports it, and handlers see it
 * through the injected `NodeGuardedFetch` type).
 *
 * The connection is opened through an undici dispatcher whose `connect.lookup`
 * resolves the hostname and validates every returned address at dial time
 * (`createGuardedLookup`), so the address that passed the SSRF policy is the
 * one dialed — a TTL=0 rebind between a pre-flight check and the dial no
 * longer reaches an internal host. Every call (including each redirect hop
 * the shared core follows) goes through the same dispatcher.
 *
 * With an operator env proxy (`HTTP(S)_PROXY`), proxied destinations are
 * resolved by that proxy (outside this process); `NO_PROXY` destinations are
 * dialed directly through the same guarded lookup.
 */
import { Agent, type Dispatcher, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import type { NodeGuardedFetch, NodeGuardedFetchOptions } from '../adapters';
import { assertNodeHostnameSafe, createGuardedLookup, isNodeDnsGuardError } from './dns-guard-node';

export interface NodeGuardedFetchConfig {
  /** Route non-`NO_PROXY` destinations through the env HTTP(S)_PROXY. */
  envProxy?: boolean;
}

/** Statuses whose Response must have a null body. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export function createNodeGuardedFetch(config: NodeGuardedFetchConfig = {}): NodeGuardedFetch {
  const dispatchers = new Map<string, Dispatcher>();
  const dispatcherFor = (options: NodeGuardedFetchOptions): Dispatcher => {
    const allowLocalhost = options.allowLocalhost === true;
    const allowPrivateIPs = options.allowPrivateIPs === true;
    const allowH2 = options.http2 === true;
    const key = `${allowLocalhost}|${allowPrivateIPs}|${allowH2}`;
    let dispatcher = dispatchers.get(key);
    if (!dispatcher) {
      const agentOptions = {
        allowH2,
        connect: { lookup: createGuardedLookup({ allowLocalhost, allowPrivateIPs }) },
      };
      // EnvHttpProxyAgent passes `connect` to its direct (NO_PROXY) agent only;
      // its proxy agents dial the configured proxy, which resolves the target.
      dispatcher = config.envProxy ? new EnvHttpProxyAgent(agentOptions) : new Agent(agentOptions);
      dispatchers.set(key, dispatcher);
    }
    return dispatcher;
  };

  return async (url, init, options) => {
    // Pre-flight: refuses literal IPs (which never reach `lookup`) and gives a
    // clear error for names; the dispatcher re-validates at dial time.
    await assertNodeHostnameSafe(new URL(url).hostname, {
      allowLocalhost: options.allowLocalhost === true,
      allowPrivateIPs: options.allowPrivateIPs === true,
    });
    let r: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      r = await undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher: dispatcherFor(options),
      });
    } catch (err) {
      // undici wraps connect failures as `TypeError: fetch failed`; surface
      // the SSRF guard's own message when that is the cause.
      const cause = (err as { cause?: unknown }).cause;
      if (isNodeDnsGuardError(cause)) throw cause;
      throw err;
    }
    // Hand back a runtime-global Response: the shared core relies on
    // `instanceof Headers` and npm undici's classes are distinct from Node's.
    return new Response(NULL_BODY_STATUS.has(r.status) ? null : (r.body as BodyInit | null), {
      status: r.status,
      statusText: r.statusText,
      headers: new Headers([...r.headers]),
    });
  };
}
