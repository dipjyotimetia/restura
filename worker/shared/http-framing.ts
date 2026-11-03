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

/** Cap on the bytes before the final head ends (interim 1xx heads included). */
const MAX_HEAD_BYTES = 64 * 1024;

/** The final (non-1xx) response head plus where and how its body is framed. */
export interface FinalHead extends ResponseHead {
  /** Byte offset of the first body byte. */
  bodyStart: number;
  contentLength: number | null;
  /** 204 / 304: nothing follows the head. */
  bodyless: boolean;
}

/** Offset of the first CRLFCRLF at or after `from`, or -1. */
function indexOfHeadEnd(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

/**
 * ISO-8859-1: each octet becomes the code point of the same value (Node's
 * 'latin1'). `TextDecoder('latin1')` is windows-1252 and would map 0x80–0x9F
 * above U+00FF, which Headers rejects.
 */
function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return out;
}

/**
 * Find the final response head in the bytes received so far, or null while it
 * is incomplete. The delimiter is found on raw bytes and the head decoded as
 * Latin-1, so non-ASCII header octets neither shift the body offset nor
 * become code points Headers rejects. Interim 1xx heads (100 Continue, 103
 * Early Hints) are skipped; 101 fails, since the request never asks to upgrade.
 */
export function findFinalHead(bytes: Uint8Array): FinalHead | null {
  let start = 0;
  for (;;) {
    const end = indexOfHeadEnd(bytes, start);
    if (end === -1) {
      if (bytes.length > MAX_HEAD_BYTES) throw new Error('Upstream response head too large');
      return null;
    }
    const head = parseResponseHead(decodeLatin1(bytes.subarray(start, end)));
    const status = parseStatusCode(head.statusLine);
    if (status === 101) throw new Error('Upstream switched protocols (101) without an upgrade');
    if (status >= 200 || status < 100) {
      const cl = head.headers['content-length'];
      const n = cl === undefined ? Number.NaN : Number.parseInt(cl, 10);
      return {
        ...head,
        bodyStart: end + 4,
        contentLength: Number.isNaN(n) ? null : n,
        bodyless: isBodylessStatus(status),
      };
    }
    start = end + 4;
  }
}

/** Whether `received` bytes (head included) complete the response before EOF. */
export function isBodyComplete(head: FinalHead, received: number): boolean {
  if (head.bodyless) return true;
  return head.contentLength !== null && received - head.bodyStart >= head.contentLength;
}

/** The body inside `all` (head + body bytes); a view, not a copy. */
export function sliceBody(all: Uint8Array, head: FinalHead): Uint8Array {
  if (head.bodyless) return new Uint8Array(0);
  const end = head.contentLength === null ? undefined : head.bodyStart + head.contentLength;
  return all.subarray(head.bodyStart, end);
}

/**
 * At EOF: a cancelled read, a missing head or a body shorter than its
 * Content-Length is an error, never a partial response.
 */
export function assertCompleteAtEof(
  head: FinalHead | null,
  received: number,
  signal: AbortSignal
): asserts head is FinalHead {
  if (signal.aborted) throw new Error('Aborted');
  if (!head) throw new Error('Upstream closed before response headers');
  const got = received - head.bodyStart;
  if (!head.bodyless && head.contentLength !== null && got < head.contentLength) {
    throw new Error(`Upstream closed after ${got} of ${head.contentLength} body bytes`);
  }
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
 * Frame `METHOD target HTTP/1.1`, headers and body. `target` is origin-form
 * (`/path?q`) through a tunnel or absolute-form through an HTTP proxy. `Host`
 * is always `authority`, written first; any caller Host (any case) is skipped
 * so the wire never carries two Host fields. Every header goes through
 * `Headers` validation first (token name; no CR/LF/NUL; octets only) and the
 * head is written as Latin-1, the bytes fetch() itself would send.
 */
export function encodeRequest(
  method: string,
  target: string,
  authority: string,
  headers: Record<string, string>,
  bodyBytes?: Uint8Array
): Uint8Array {
  // Each tunnel carries exactly one request. `Connection: close` makes the
  // upstream end the connection after the response, which is what the
  // no-Content-Length read path (read to EOF) relies on; without it a
  // keep-alive server never closes and the request waits for the timeout.
  let raw = `${method} ${target} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (name !== 'host' && name !== 'connection') raw += `${k}: ${checkedHeaderValue(k, v)}\r\n`;
  }
  raw += '\r\n';
  const head = encodeLatin1(raw);
  if (!bodyBytes || bodyBytes.length === 0) return head;
  const wire = new Uint8Array(head.length + bodyBytes.length);
  wire.set(head);
  wire.set(bodyBytes, head.length);
  return wire;
}

/**
 * The value `Headers` would store for one field (edge whitespace trimmed), or
 * throw if the name is not a token or the value carries CR/LF/NUL or code
 * points above U+00FF — anything that could forge lines on the proxy socket.
 * The message names the header only: the value may be a credential.
 */
function checkedHeaderValue(name: string, value: string): string {
  try {
    return new Headers([[name, value]]).get(name) ?? '';
  } catch {
    throw new Error(`Invalid request header "${name}": not a valid HTTP field`);
  }
}

/** Code points ≤ U+00FF to the same octets (inputs are Headers-validated). */
function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/**
 * Build the fetch Response from a parsed reply. Null-body statuses (204, 205,
 * 304) get a null body — the Response constructor throws otherwise. Headers
 * come from the ordered list so repeated fields survive.
 */
export function toResponse(
  statusLine: string,
  headerList: Array<[string, string]>,
  body: Uint8Array
): Response {
  const status = parseStatusCode(statusLine);
  // Fetch's null-body statuses (Response() throws on a body for these). This
  // differs from isBodylessStatus on purpose: that one is the HTTP message
  // rule (1xx/204/304 carry no body on the wire), this one is what Response
  // accepts (205 included). 1xx never gets here: findFinalHead skips it.
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : body, { status, headers: headerList });
}
