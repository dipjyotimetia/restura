import { z } from 'zod';
import { type McpTransport, type McpValidationOptions, validateMcpSpec } from './mcp-proxy';

/**
 * Streamable HTTP session termination (MCP 2025-06-18 *Session Management*):
 * a client that no longer needs a session SHOULD send `DELETE` to the MCP
 * endpoint with the `Mcp-Session-Id` header (#888).
 *
 * The web/self-host client reaches this through `POST /api/mcp/terminate`.
 * Validation deliberately reuses `validateMcpSpec` so the DELETE target goes
 * through exactly the same SSRF guard, header sanitisation, session/version
 * header handling and timeout clamping as every other MCP request.
 */
export interface McpTerminateSpec {
  url: string;
  transport: McpTransport;
  postEndpoint?: string;
  sessionId: string;
  protocolVersion?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export type McpTerminateValidation =
  | { ok: true; targetUrl: string; headers: Record<string, string>; timeoutMs: number }
  | { ok: false; status: number; error: string };

/** Body schema for `POST /api/mcp/terminate`. Mirrors `McpTerminateSpec`. */
export const McpTerminateBodySchema = z.object({
  url: z.string().min(1),
  transport: z.string().min(1),
  postEndpoint: z.string().optional(),
  sessionId: z.string().min(1).max(1024),
  protocolVersion: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().min(0).max(300_000).optional(),
});

/** Session termination is a short best-effort call; never wait the full RPC budget. */
const MAX_TERMINATE_TIMEOUT_MS = 10_000;

export function validateMcpTerminateSpec(
  spec: McpTerminateSpec,
  options: McpValidationOptions
): McpTerminateValidation {
  if (spec.transport !== 'streamable-http') {
    // Legacy HTTP+SSE has no DELETE semantics — the session ends with the stream.
    return { ok: false, status: 400, error: 'Session termination requires streamable-http' };
  }
  if (typeof spec.sessionId !== 'string' || spec.sessionId.length === 0) {
    return { ok: false, status: 400, error: 'Session termination requires `sessionId`' };
  }
  const v = validateMcpSpec(
    {
      url: spec.url,
      transport: spec.transport,
      sessionId: spec.sessionId,
      ...(spec.protocolVersion !== undefined ? { protocolVersion: spec.protocolVersion } : {}),
      ...(spec.headers ? { headers: spec.headers } : {}),
      // Placeholder envelope: only the target URL / headers are used. The
      // method is not `initialize`, so the negotiated version header is kept.
      jsonRpc: { method: 'session/terminate', id: 0 },
      timeout: Math.min(spec.timeout ?? MAX_TERMINATE_TIMEOUT_MS, MAX_TERMINATE_TIMEOUT_MS),
    },
    options
  );
  if (!v.ok) return v;
  const headers: Record<string, string> = {};
  for (const [k, value] of Object.entries(v.headers)) {
    // DELETE carries no body.
    if (k.toLowerCase() !== 'content-type') headers[k] = value;
  }
  return { ok: true, targetUrl: v.targetUrl, headers, timeoutMs: v.timeoutMs };
}
