import { validateURL } from './url-validation';
import { sanitizeRequestHeaders } from './header-policy';

/**
 * Shared MCP proxy validation/preparation. Both the Cloudflare Worker
 * (`worker/handlers/mcp.ts`) and the Electron MCP IPC handler can route their
 * one-shot JSON-RPC POSTs through this helper to share URL guards, header
 * sanitisation, JSON-RPC envelope construction, and timeout clamping.
 *
 * This is intentionally validation-only: no I/O, no streaming. Long-lived
 * SSE/notification handling stays in the transport-specific code.
 */

export type McpTransport = 'streamable-http' | 'http-sse';

export interface McpSpec {
  url: string;
  transport: McpTransport;
  postEndpoint?: string;
  sessionId?: string;
  headers?: Record<string, string>;
  jsonRpc: { method: string; params?: unknown; id: string | number };
  timeout?: number;
}

export type McpValidation =
  | {
      ok: true;
      targetUrl: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
    }
  | { ok: false; status: number; error: string };

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;

/** Shape of a JSON-RPC 2.0 error object. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Validate the shape of an untrusted JSON-RPC error object. Returns a typed
 * `JsonRpcError` when the wire data matches `{ code: number, message: string }`,
 * or `null` otherwise. This is robust parsing, not a gate — callers fall back to
 * a generic message rather than rejecting the response.
 */
export function parseJsonRpcError(raw: unknown): JsonRpcError | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.code !== 'number' || typeof obj.message !== 'string') return null;
  return {
    code: obj.code,
    message: obj.message,
    ...('data' in obj ? { data: obj.data } : {}),
  };
}

/**
 * Produce a clean, human-readable Error from an (untrusted) JSON-RPC error
 * payload. Falls back to a best-effort message when the shape is malformed so a
 * surfaced error is never silently dropped.
 */
export function jsonRpcErrorToMessage(raw: unknown): string {
  const parsed = parseJsonRpcError(raw);
  if (parsed) return `JSON-RPC error ${parsed.code}: ${parsed.message}`;
  // Malformed error object — surface whatever message-like field we can find.
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.code === 'number') return `JSON-RPC error ${obj.code}`;
  }
  return 'Unknown JSON-RPC error';
}

export interface McpValidationOptions {
  allowLocalhost: boolean;
  /** Self-hosted opt-in for RFC 1918 / link-local / CGNAT MCP server URLs. */
  allowPrivateIPs?: boolean;
}

export function validateMcpSpec(
  spec: McpSpec,
  optionsOrAllowLocalhost: boolean | McpValidationOptions
): McpValidation {
  // Back-compat: callers (Electron, contract tests) still pass a boolean.
  const opts: McpValidationOptions =
    typeof optionsOrAllowLocalhost === 'boolean'
      ? { allowLocalhost: optionsOrAllowLocalhost }
      : optionsOrAllowLocalhost;
  if (spec.transport !== 'streamable-http' && spec.transport !== 'http-sse') {
    return {
      ok: false,
      status: 400,
      error: 'Invalid `transport` (expected "streamable-http" or "http-sse")',
    };
  }
  if (!spec.jsonRpc || typeof spec.jsonRpc.method !== 'string' || spec.jsonRpc.id === undefined) {
    return { ok: false, status: 400, error: 'Invalid `jsonRpc` (method and id are required)' };
  }

  const targetUrl =
    spec.transport === 'http-sse'
      ? spec.postEndpoint && spec.postEndpoint.length > 0
        ? spec.postEndpoint
        : null
      : spec.url;
  if (!targetUrl) {
    return { ok: false, status: 400, error: 'http-sse transport requires `postEndpoint`' };
  }

  const v = validateURL(targetUrl, {
    allowPrivateIPs: opts.allowPrivateIPs === true,
    allowLocalhost: opts.allowLocalhost,
  });
  if (!v.valid) return { ok: false, status: 400, error: `Invalid URL: ${v.error}` };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...sanitizeRequestHeaders(spec.headers, 'mcp'),
  };
  if (spec.sessionId) headers['Mcp-Session-Id'] = spec.sessionId;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: spec.jsonRpc.id,
    method: spec.jsonRpc.method,
    ...(spec.jsonRpc.params !== undefined ? { params: spec.jsonRpc.params } : {}),
  });

  const timeoutMs = Math.min(spec.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  return { ok: true, targetUrl, headers, body, timeoutMs };
}
