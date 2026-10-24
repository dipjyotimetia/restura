/**
 * Main-side MCP connection credential materialization (#896, SEC-3).
 *
 * The renderer sends the header-shaped MCP auth descriptor over the
 * `mcp:connect` IPC call with SecretRef handle / external refs left opaque
 * (ADR-0007). This resolves them here, at connect time, into the transport's
 * base request headers — so the plaintext only ever lives in the main
 * process. Built on the streaming materializer the WebSocket / SSE handlers
 * share (`ws-handshake-auth.ts`), with MCP's transport rules:
 *
 *   - only header-shaped auth (shared `mcpAuthUnsupportedReason` policy) —
 *     never a query-string credential, never a sign-at-wire scheme;
 *   - auth may not set hop-by-hop / security-sensitive streaming headers or
 *     the headers the MCP transport owns (`Mcp-Session-Id`, `Accept`, …).
 *
 * Fails closed: a configured credential that resolves to nothing (revoked /
 * missing handle, empty vault value) throws instead of opening an
 * unauthenticated session. Thrown messages never contain resolved plaintext,
 * and the returned `redact` scrubs it from anything sent back to the renderer.
 */

import { isMcpTransportHeader, mcpAuthUnsupportedReason } from '@shared/protocol/mcp-auth';
import type { ProtocolAuthConfig } from '@shared/protocol/types';
import { isDeniedStreamingHeader } from '../ipc/validators/core';
import {
  materializeStreamingAuth,
  type SecretRedactor,
  type StreamingAuthTransport,
} from './ws-handshake-auth';

/** MCP POST / GET-SSE requests: the streaming IPC denylist plus MCP-owned headers. */
export const MCP_REQUEST_TRANSPORT: StreamingAuthTransport = {
  allowedSchemes: ['http:', 'https:'],
  isForbiddenHeader: (name) => isDeniedStreamingHeader(name) || isMcpTransportHeader(name),
  label: 'MCP',
};

export interface McpConnectAuthConfig {
  url: string;
  headers?: Record<string, string> | undefined;
  auth?: ProtocolAuthConfig | undefined;
}

export interface MaterializedMcpConnect {
  headers: Record<string, string>;
  /** Scrubs resolved plaintext from replies / events / logs for this connection. */
  redact: SecretRedactor;
}

const identity: SecretRedactor = (text) => text;

/**
 * Apply a {@link SecretRedactor} to every string (values and keys) in a
 * JSON-shaped value — JSON-RPC results, error `data` and notifications are
 * server-controlled and may echo the resolved credential back. Returns a
 * fresh copy; cycles collapse to `null`. Non-plain objects pass through.
 */
export function redactDeep<T>(value: T, redact: SecretRedactor): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v);
    if (!v || typeof v !== 'object') return v;
    // `seen` holds only the current ancestor path: a shared (non-cyclic)
    // reference is walked again, a true cycle collapses to null.
    if (seen.has(v)) return null;
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map(walk);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(v)) out[redact(key)] = walk(child);
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value) as T;
}

/** True when the connect carries auth that must be resolved main-side. */
export function needsMcpConnectAuth(config: McpConnectAuthConfig): boolean {
  return config.auth !== undefined && config.auth.type !== 'none';
}

/**
 * Resolve MCP connection auth into request headers. Returns the headers
 * untouched when there is no auth. Throws (caller maps to a connect error) on
 * an unsupported auth type / placement, an unavailable credential, a
 * forbidden header, or a malformed header value.
 */
export async function materializeMcpConnectAuth(
  config: McpConnectAuthConfig,
  signal?: AbortSignal
): Promise<MaterializedMcpConnect> {
  if (!needsMcpConnectAuth(config)) {
    return { headers: config.headers ?? {}, redact: identity };
  }
  const reason = mcpAuthUnsupportedReason(config.auth);
  if (reason) throw new Error(reason);

  const materialized = await materializeStreamingAuth(
    { url: config.url, headers: config.headers, auth: config.auth },
    MCP_REQUEST_TRANSPORT,
    signal
  );
  // Header-only policy (query placement rejected above): the materialized URL
  // is deliberately ignored — the caller keeps connecting to the URL its SSRF
  // guard validated and pinned.
  return { headers: materialized.headers, redact: materialized.redact };
}
