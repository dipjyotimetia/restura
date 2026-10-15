export const REQUEST_DENY = new Set<string>([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
]);

export const REQUEST_DENY_MCP = new Set<string>([...REQUEST_DENY, 'cookie']);

export const RESPONSE_DENY = new Set<string>([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'trailer',
  'upgrade',
]);

/**
 * Upstream headers that must not reach the browser on the Worker's streamed
 * pass-through: the browser would act on them against the Restura origin
 * (wipe its storage, pin HSTS / keys, switch protocols, pop a native auth
 * prompt, follow or refresh to an upstream-chosen URL, preload resources).
 * The buffered proxy is unaffected — it returns headers as JSON data.
 * `Set-Cookie` is handled separately (cookie side channel).
 */
export const STREAM_FORWARD_DENY = new Set<string>([
  ...RESPONSE_DENY,
  'alt-svc',
  'clear-site-data',
  'content-security-policy',
  'content-security-policy-report-only',
  'link',
  'location',
  'nel',
  'public-key-pins',
  'public-key-pins-report-only',
  'refresh',
  'report-to',
  'reporting-endpoints',
  'set-cookie',
  'strict-transport-security',
  'www-authenticate',
]);

/**
 * Split upstream response headers for a streamed pass-through: `forward` may
 * be set on the proxy's reply; `withheld` (minus Set-Cookie, which has its own
 * side channel) is what the renderer should still be able to display.
 */
export function splitStreamForwardHeaders(input: Record<string, string>): {
  forward: Record<string, string>;
  withheld: Record<string, string>;
} {
  const forward: Record<string, string> = {};
  const withheld: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const lower = k.toLowerCase();
    if (!STREAM_FORWARD_DENY.has(lower)) forward[k] = v;
    else if (lower !== 'set-cookie' && !RESPONSE_DENY.has(lower)) withheld[k] = v;
  }
  return { forward, withheld };
}

/**
 * Aggregate cap on outbound gRPC metadata (sum of UTF-8 key + value bytes).
 *
 * There is deliberately no per-entry cap: HTTP/2 imposes none, and ordinary
 * bearer JWTs (Azure AD, Auth0 with claims, GCP ID tokens) run 1.2–2 KB. 16 KiB
 * matches common server defaults (grpc-go / nginx / Envoy accept at least this
 * much) while still catching runaway metadata before it hits the wire (#895).
 */
export const MAX_GRPC_METADATA_BYTES = 16 * 1024;

export type RequestPolicy = 'default' | 'mcp';

export function sanitizeRequestHeaders(
  input: Record<string, string> | undefined,
  policy: RequestPolicy = 'default'
): Record<string, string> {
  if (!input) return {};
  const deny = policy === 'mcp' ? REQUEST_DENY_MCP : REQUEST_DENY;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!deny.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export function sanitizeResponseHeaders(
  input: Record<string, string | string[]> | Headers
): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (key: string, value: string) => {
    if (!RESPONSE_DENY.has(key.toLowerCase())) out[key] = value;
  };
  if (input instanceof Headers) {
    input.forEach((v, k) => visit(k, v));
    return out;
  }
  for (const [k, v] of Object.entries(input)) {
    visit(k, Array.isArray(v) ? v.join(', ') : v);
  }
  return out;
}

/**
 * Every value of the response header field `name` (lower-case), one entry per
 * field line. Node/undici records hold repeated fields as a `string[]`; a Fetch
 * `Headers` can only return the comma-joined value — except for `set-cookie`,
 * which `Headers.getSetCookie()` returns unfolded.
 */
export function headerFieldValues(
  input: Record<string, string | string[]> | Headers,
  name: string
): string[] {
  if (input instanceof Headers) {
    if (name === 'set-cookie' && typeof input.getSetCookie === 'function') {
      return input.getSetCookie();
    }
    const v = input.get(name);
    return v ? [v] : [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k.toLowerCase() !== name) continue;
    if (Array.isArray(v)) out.push(...v);
    else if (typeof v === 'string' && v !== '') out.push(v);
  }
  return out;
}

/**
 * Every `Set-Cookie` value on a response, one entry per header field.
 *
 * RFC 6265 §3 / RFC 9110 §5.3: Set-Cookie is the one header that must never be
 * list-combined (cookie attributes such as `Expires` contain commas), so the
 * flattened `Record<string, string>` from `sanitizeResponseHeaders` can't carry
 * it faithfully. Fetch paths use `Headers.getSetCookie()`; Node/undici records
 * already hold a `string[]`.
 */
export function extractSetCookies(input: Record<string, string | string[]> | Headers): string[] {
  return headerFieldValues(input, 'set-cookie');
}
