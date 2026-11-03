/**
 * Runtime-neutral HTTP/1.1 framing for the upstream-proxy twins
 * (`tcp-proxy.ts` on Cloudflare sockets, `tcp-proxy-node.ts` on node:net/tls).
 * Web APIs only (Uint8Array, TextEncoder, Response, Headers), so both twins
 * share one byte-level behaviour; socket I/O stays in the twins.
 */

const ENCODER = new TextEncoder();

/** One response head: status line plus header fields. */
export interface ResponseHead {
  statusLine: string;
  /** Lower-cased names; a repeated field keeps its last value. */
  headers: Record<string, string>;
  /** Every field in wire order with duplicates kept (repeated Set-Cookie, #855). */
  headerList: Array<[string, string]>;
}

/**
 * Normalise HeadersInit (Record | Headers | [k, v][]) into a fresh plain Record.
 * `Object.entries(new Headers())` yields [] — the redirect follower passes a
 * Headers instance, so without this every redirected hop would drop its headers.
 */
export function toRecord(input: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (input instanceof Headers) {
    input.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(input)) {
    for (const [k, v] of input) out[k] = v;
    return out;
  }
  return Object.assign(out, input);
}

/**
 * `HTTP/1.1 200 OK` → 200. Exact-matches the second token (a reason phrase
 * such as `502 Backend 200 unavailable` must not read as 200); an unparseable
 * line maps to 502.
 */
export function parseStatusCode(statusLine: string): number {
  const token = statusLine.split(' ')[1];
  if (!token) return 502;
  const n = Number.parseInt(token, 10);
  return Number.isNaN(n) ? 502 : n;
}

/** 1xx, 204 and 304 never carry a body on the wire (RFC 9112 §6.3). */
export function isBodylessStatus(code: number): boolean {
  return (code >= 100 && code < 200) || code === 204 || code === 304;
}

/**
 * Parse a decoded header section (everything before the blank line, without
 * the terminating CRLFCRLF). Lines without a colon are ignored; names are
 * lower-cased and names/values trimmed.
 */
export function parseResponseHead(headText: string): ResponseHead {
  const lines = headText.split('\r\n');
  const headers: Record<string, string> = {};
  const headerList: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = value;
    headerList.push([name, value]);
  }
  return { statusLine: lines[0] ?? '', headers, headerList };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k];
}

/**
 * Serialise a fetch body to the exact bytes framed on the wire and set the
 * matching Content-Length (replacing any caller value, any case) — mutates
 * `headers`. Strings are UTF-8 encoded; byte views pass through without a
 * copy; anything else (FormData, Blob, URLSearchParams, streams) goes through
 * `new Response(body)`, which yields the bytes and the Content-Type fetch()
 * would send (the multipart boundary for FormData) — set only when the caller
 * set none. A null/undefined body returns undefined and leaves headers alone.
 */
export async function frameBody(
  body: RequestInit['body'],
  headers: Record<string, string>
): Promise<Uint8Array | undefined> {
  if (body == null) return undefined;
  let bytes: Uint8Array;
  if (typeof body === 'string') {
    bytes = ENCODER.encode(body);
  } else if (body instanceof Uint8Array) {
    bytes = body;
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else {
    const serialised = new Response(body);
    const contentType = serialised.headers.get('content-type');
    if (contentType && !hasHeader(headers, 'content-type')) headers['Content-Type'] = contentType;
    bytes = new Uint8Array(await serialised.arrayBuffer());
  }
  deleteHeader(headers, 'content-length');
  headers['Content-Length'] = String(bytes.byteLength);
  return bytes;
}

/**
 * Frame `METHOD target HTTP/1.1`, headers and body as UTF-8 bytes. `target`
 * is origin-form (`/path?q`) through a tunnel or absolute-form through an
 * HTTP proxy. `Host` is always `authority`, written first; any caller Host
 * (any case) is skipped so the wire never carries two Host fields.
 */
export function encodeRequest(
  method: string,
  target: string,
  authority: string,
  headers: Record<string, string>,
  bodyBytes?: Uint8Array
): Uint8Array {
  let raw = `${method} ${target} HTTP/1.1\r\nHost: ${authority}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'host') raw += `${k}: ${v}\r\n`;
  }
  raw += '\r\n';
  const head = ENCODER.encode(raw);
  if (!bodyBytes || bodyBytes.length === 0) return head;
  const wire = new Uint8Array(head.length + bodyBytes.length);
  wire.set(head);
  wire.set(bodyBytes, head.length);
  return wire;
}

/**
 * Build the fetch Response from a parsed reply. Null-body statuses (101, 204,
 * 205, 304) get a null body — the Response constructor throws otherwise.
 * Headers come from the ordered list so repeated fields survive.
 */
export function toResponse(
  statusLine: string,
  headerList: Array<[string, string]>,
  body: Uint8Array
): Response {
  const status = parseStatusCode(statusLine);
  const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : body, { status, headers: headerList });
}
