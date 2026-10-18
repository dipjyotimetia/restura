/**
 * SSRF-guarded fetch for the MCP OAuth 2.1 flow (#856, ADR 0031).
 *
 * Every request the OAuth client makes OUTSIDE the MCP session itself —
 * RFC 9728 Protected Resource Metadata, RFC 8414 / OIDC authorization-server
 * metadata, RFC 7591 Dynamic Client Registration and the token endpoint —
 * goes through {@link createMcpOAuthFetch}. Those URLs are attacker-influenced
 * (a `WWW-Authenticate: resource_metadata=` header, a PRM document's
 * `authorization_servers`, AS metadata endpoints), so each one is:
 *
 *   1. scheme-checked: `https:` only, or `http:` for a loopback development
 *      AS when the desktop localhost carve-out is on ({@link assertOAuthEndpointUrl});
 *   2. checked against the shared string-level SSRF policy (`validateURL`);
 *   3. DNS-resolved once, every record validated, and the connection pinned
 *      to the validated IP (`resolveSafeAddress` + `createPolicyPinnedFetch`),
 *      honouring the acknowledged TLS policy;
 *   4. never auto-redirected: a 3xx on a GET is re-validated hop by hop
 *      (steps 1-3 again, max {@link MAX_REDIRECTS}); a 3xx on a POST (token /
 *      registration) fails closed so credentials are never replayed elsewhere;
 *   5. size-capped ({@link MCP_OAUTH_MAX_RESPONSE_BYTES}) and time-boxed.
 *
 * The MCP session's own transport keeps its DNS-pinned fetch, which refuses
 * any other hostname — so an OAuth endpoint can never ride the MCP pin.
 */

import { isLoopbackAddress, isPrivateAddress, validateURL } from '@shared/protocol/url-validation';
import { getExecutionPolicy } from './execution-policy';
import {
  assertPinnedFetchCanHonorPolicy,
  createPolicyPinnedFetch,
  resolvePolicyTransport,
} from './policy-transport';
import { resolveSafeAddress } from './safe-connect';

/** Metadata / token / registration documents are small; anything bigger is hostile. */
export const MCP_OAUTH_MAX_RESPONSE_BYTES = 256 * 1024;
export const MCP_OAUTH_FETCH_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;

export type OAuthFetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface OAuthUrlPolicy {
  allowLocalhost: boolean;
  allowPrivateIPs?: boolean;
}

/**
 * What the MCP server itself is allowed to be, which bounds where its OAuth
 * endpoints may live: a remote server must not steer the client to loopback
 * or LAN endpoints (remote → local pivot), so the desktop localhost / private
 * carve-outs only apply when the MCP server is itself loopback / private.
 */
export interface McpOAuthCarveOut {
  serverIsLoopback: boolean;
  serverIsPrivate: boolean;
}

/** Derive the carve-out from the MCP server URL and its validated, pinned IP. */
export function mcpOAuthCarveOut(serverUrl: string, resolvedIp?: string): McpOAuthCarveOut {
  const host = new URL(serverUrl).hostname;
  const serverIsLoopback =
    isLoopbackHost(host) || (resolvedIp !== undefined && isLoopbackAddress(resolvedIp));
  const ip = resolvedIp ?? stripBrackets(host);
  return { serverIsLoopback, serverIsPrivate: !serverIsLoopback && isPrivateAddress(ip) };
}

/** The OAuth endpoint policy: the global security policy, narrowed by the carve-out. */
export function mcpOAuthUrlPolicy(carve: McpOAuthCarveOut): OAuthUrlPolicy {
  const global = getExecutionPolicy().security;
  return {
    allowLocalhost: global.allowLocalhost && carve.serverIsLoopback,
    allowPrivateIPs: global.allowPrivateIPs === true && carve.serverIsPrivate,
  };
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

/** True for `localhost` and loopback literals (the only hosts plain http is allowed for). */
export function isLoopbackHost(hostname: string): boolean {
  return isLoopbackAddress(stripBrackets(hostname.toLowerCase()));
}

/**
 * Validate an OAuth endpoint (metadata, token, registration, authorization)
 * URL against the MCP OAuth policy. Throws a plaintext-free error.
 */
export function assertOAuthEndpointUrl(raw: string, policy: OAuthUrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('OAuth endpoint URL is invalid');
  }
  if (url.username || url.password) {
    throw new Error('OAuth endpoint URLs must not embed credentials');
  }
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      throw new Error(
        `OAuth endpoint ${url.origin} must use https — plain http is allowed only for a loopback development server`
      );
    }
    if (!policy.allowLocalhost) {
      throw new Error(
        'Loopback OAuth endpoints are blocked — enable localhost in Settings → Security'
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new Error(`OAuth endpoint scheme ${url.protocol} is not allowed`);
  }
  const verdict = validateURL(url.href, {
    allowLocalhost: policy.allowLocalhost,
    allowPrivateIPs: policy.allowPrivateIPs === true,
    maxUrlLength: 8192,
  });
  if (!verdict.valid) {
    throw new Error(`OAuth endpoint blocked: ${verdict.error ?? 'disallowed URL'}`);
  }
  return url;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Buffer a response body up to `maxBytes`, failing closed (and cancelling) beyond it. */
export async function capResponse(res: Response, maxBytes: number): Promise<Response> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`OAuth response exceeds ${maxBytes} bytes`);
  }
  let body: Uint8Array | null = null;
  if (res.body && !NULL_BODY_STATUSES.has(res.status)) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`OAuth response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(body as BodyInit | null, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export interface McpOAuthFetchOptions {
  /** Aborts every in-flight OAuth request (connection disposed / cancelled). */
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * Endpoint policy, re-read per request. Defaults to the global security
   * policy; MCP sessions pass {@link mcpOAuthUrlPolicy} for their server.
   */
  policy?: () => OAuthUrlPolicy;
}

/**
 * Build the guarded fetch the OAuth client uses for every non-MCP request.
 * The execution policy is re-read per call, so a Settings change applies to
 * the next request.
 */
export function createMcpOAuthFetch(options: McpOAuthFetchOptions = {}): OAuthFetchLike {
  const maxBytes = options.maxBytes ?? MCP_OAUTH_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? MCP_OAUTH_FETCH_TIMEOUT_MS;

  return async (input, init) => {
    let url = requestUrl(input as string | URL | Request);
    const method = (init?.method ?? 'GET').toUpperCase();
    for (let hop = 0; ; hop++) {
      const security = options.policy?.() ?? getExecutionPolicy().security;
      const target = assertOAuthEndpointUrl(url, security);
      const transport = resolvePolicyTransport({ url: target.href });
      assertPinnedFetchCanHonorPolicy(transport);
      const pinned = await resolveSafeAddress(target.href, {
        allowLocalhost: security.allowLocalhost,
        allowPrivateIPs: security.allowPrivateIPs === true,
      });
      const pinnedFetch = createPolicyPinnedFetch(transport, pinned);

      const signals = [AbortSignal.timeout(timeoutMs)];
      if (init?.signal) signals.push(init.signal);
      if (options.signal) signals.push(options.signal);

      const res = await pinnedFetch(target.href, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
      });

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        if (method !== 'GET' && method !== 'HEAD') {
          throw new Error(
            `OAuth endpoint ${target.origin} redirected a ${method} — refusing to replay it`
          );
        }
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`OAuth endpoint redirected more than ${MAX_REDIRECTS} times`);
        }
        url = new URL(location, target).href;
        continue;
      }
      return capResponse(res, maxBytes);
    }
  };
}
