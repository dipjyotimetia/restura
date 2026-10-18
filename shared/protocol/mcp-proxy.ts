import { sanitizeRequestHeaders } from './header-policy';
import {
  isMcpNotificationMethod,
  isValidMcpProtocolVersion,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_ID_HEADER,
} from './mcp-version';
import { validateURL } from './url-validation';

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
  /**
   * Protocol version negotiated by `initialize`. When set, every request
   * except `initialize` itself carries `MCP-Protocol-Version` (MCP
   * 2025-06-18 Streamable HTTP, #865).
   */
  protocolVersion?: string;
  headers?: Record<string, string>;
  /** `id` may be omitted only for `notifications/*` methods (JSON-RPC notification). */
  jsonRpc: { method: string; params?: unknown; id?: string | number };
  timeout?: number;
}

export type McpValidation =
  | {
      ok: true;
      targetUrl: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
      /** True when the envelope is a JSON-RPC notification (no id, no reply expected). */
      isNotification: boolean;
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
  if (!spec.jsonRpc || typeof spec.jsonRpc.method !== 'string') {
    return { ok: false, status: 400, error: 'Invalid `jsonRpc` (method and id are required)' };
  }
  const isNotification =
    spec.jsonRpc.id === undefined && isMcpNotificationMethod(spec.jsonRpc.method);
  if (spec.jsonRpc.id === undefined && !isNotification) {
    return { ok: false, status: 400, error: 'Invalid `jsonRpc` (method and id are required)' };
  }
  if (spec.protocolVersion !== undefined && !isValidMcpProtocolVersion(spec.protocolVersion)) {
    return { ok: false, status: 400, error: 'Invalid `protocolVersion`' };
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
  // Userinfo in an MCP URL is never sent (fetch refuses it) and would only
  // leak into logs; credentials belong in headers.
  if (hasUserinfo(targetUrl)) {
    return { ok: false, status: 400, error: 'Invalid URL: credentials in URL are not allowed' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...sanitizeRequestHeaders(spec.headers, 'mcp'),
  };
  if (spec.sessionId) setHeader(headers, MCP_SESSION_ID_HEADER, spec.sessionId);
  // The version header is negotiated BY initialize, so it is never sent on it.
  if (spec.protocolVersion && spec.jsonRpc.method !== 'initialize') {
    setHeader(headers, MCP_PROTOCOL_VERSION_HEADER, spec.protocolVersion);
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    ...(isNotification ? {} : { id: spec.jsonRpc.id }),
    method: spec.jsonRpc.method,
    ...(spec.jsonRpc.params !== undefined ? { params: spec.jsonRpc.params } : {}),
  });

  const timeoutMs = Math.min(spec.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  return { ok: true, targetUrl, headers, body, timeoutMs, isNotification };
}

function hasUserinfo(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.username !== '' || u.password !== '';
  } catch {
    return false; // unparsable URLs were already rejected by validateURL
  }
}

/**
 * Set a header, replacing any case-variant the caller supplied, so a
 * user-entered `mcp-protocol-version` can't be joined with the negotiated
 * value into a comma-list by `Headers`.
 */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}
