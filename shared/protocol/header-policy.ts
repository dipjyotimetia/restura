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
 * Every `Set-Cookie` value on a response, one entry per header field.
 *
 * RFC 6265 §3 / RFC 9110 §5.3: Set-Cookie is the one header that must never be
 * list-combined (cookie attributes such as `Expires` contain commas), so the
 * flattened `Record<string, string>` from `sanitizeResponseHeaders` can't carry
 * it faithfully. Fetch paths use `Headers.getSetCookie()`; Node/undici records
 * already hold a `string[]`.
 */
export function extractSetCookies(input: Record<string, string | string[]> | Headers): string[] {
  if (input instanceof Headers) {
    if (typeof input.getSetCookie === 'function') return input.getSetCookie();
    const v = input.get('set-cookie');
    return v ? [v] : [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    if (Array.isArray(v)) out.push(...v);
    else if (typeof v === 'string' && v !== '') out.push(v);
  }
  return out;
}
