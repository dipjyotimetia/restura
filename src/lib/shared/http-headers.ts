/**
 * Catalog of standard HTTP header names + common values, used to populate the
 * Headers-tab autocomplete in the Request Builder. Free-form values are still
 * accepted — the catalog is purely a suggestion list.
 *
 * Names are kept in their canonical IANA / RFC casing (HTTP/1.1 header names
 * are case-insensitive on the wire, but consistent casing helps readability
 * and matches what most servers log). Lower-cased entries (DNT, x-api-key,
 * etc.) are kept lower-case where that's the de-facto convention.
 */
export interface HttpHeaderDef {
  /** Canonical name, e.g. "Content-Type" or "x-api-key". */
  name: string;
  /** Optional secondary line shown beneath the name in the dropdown. */
  description?: string;
  /**
   * Common values for this header. The first entry is treated as the default
   * and auto-filled into the row's value column when the value field is empty.
   */
  values?: ReadonlyArray<string>;
}

const CONTENT_TYPES = [
  'application/json',
  'application/xml',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'text/html',
  'application/octet-stream',
] as const;

const ACCEPT_TYPES = [
  'application/json',
  'application/xml',
  'text/plain',
  'text/html',
  '*/*',
] as const;

export const STANDARD_HTTP_HEADERS: ReadonlyArray<HttpHeaderDef> = [
  { name: 'Accept', description: 'Media types acceptable for the response', values: ACCEPT_TYPES },
  {
    name: 'Accept-Charset',
    description: 'Acceptable character sets',
    values: ['utf-8', 'iso-8859-1'],
  },
  {
    name: 'Accept-Encoding',
    description: 'Acceptable content codings',
    values: ['gzip', 'deflate', 'br', 'identity', 'gzip, deflate, br'],
  },
  {
    name: 'Accept-Language',
    description: 'Preferred natural languages',
    values: ['en-US,en;q=0.9', 'en', '*'],
  },
  { name: 'Access-Control-Request-Headers', description: 'CORS preflight: requested headers' },
  {
    name: 'Access-Control-Request-Method',
    description: 'CORS preflight: requested method',
    values: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  },
  {
    name: 'Authorization',
    description: 'Authentication credentials',
    values: ['Bearer ', 'Basic '],
  },
  {
    name: 'Cache-Control',
    description: 'Caching directives',
    values: ['no-cache', 'no-store', 'max-age=0', 'max-age=3600', 'public', 'private'],
  },
  {
    name: 'Connection',
    description: 'Control options for the connection',
    values: ['keep-alive', 'close'],
  },
  { name: 'Content-Length', description: 'Size of the request body in bytes' },
  { name: 'Content-MD5', description: 'MD5 digest of the request body' },
  {
    name: 'Content-Transfer-Encoding',
    description: 'Body encoding for non-7bit transports',
    values: ['base64', '7bit', '8bit', 'binary', 'quoted-printable'],
  },
  { name: 'Content-Type', description: 'Media type of the request body', values: CONTENT_TYPES },
  { name: 'Cookie', description: 'HTTP cookies stored by the client' },
  { name: 'Date', description: 'Date and time the message was originated' },
  { name: 'Expect', description: 'Server behavior the client expects', values: ['100-continue'] },
  { name: 'From', description: 'Email address of the user making the request' },
  { name: 'Host', description: 'Authority of the target resource' },
  { name: 'If-Match', description: 'Make request conditional on ETag match' },
  { name: 'If-Modified-Since', description: 'Make request conditional on modification date' },
  { name: 'If-None-Match', description: 'Make request conditional on ETag mismatch' },
  { name: 'If-Range', description: 'Conditional range request' },
  { name: 'If-Unmodified-Since', description: 'Make request conditional on no modification' },
  { name: 'Keep-Alive', description: 'Tuning parameters for the connection' },
  { name: 'Max-Forwards', description: 'Limit hops through proxies (TRACE/OPTIONS)' },
  { name: 'Origin', description: 'Originating scheme + host of the request' },
  { name: 'Pragma', description: 'Legacy cache directives', values: ['no-cache'] },
  { name: 'Proxy-Authorization', description: 'Credentials for an intermediate proxy' },
  { name: 'Range', description: 'Byte range request', values: ['bytes=0-'] },
  { name: 'Referer', description: 'Address of the previous web page' },
  {
    name: 'TE',
    description: 'Acceptable transfer codings',
    values: ['trailers', 'gzip', 'deflate'],
  },
  { name: 'Trailer', description: 'Header fields present in the trailer' },
  {
    name: 'Transfer-Encoding',
    description: 'Encoding applied for transfer',
    values: ['chunked', 'identity', 'gzip'],
  },
  { name: 'Upgrade', description: 'Request a protocol upgrade', values: ['websocket', 'h2c'] },
  { name: 'User-Agent', description: 'Client product/version string' },
  { name: 'Via', description: 'Intermediate gateways/proxies traversed' },
  { name: 'Warning', description: 'Additional information about message status' },
  { name: 'X-Requested-With', description: 'XHR / framework marker', values: ['XMLHttpRequest'] },
  { name: 'X-Do-Not-Track', description: 'Legacy do-not-track signal', values: ['1', '0'] },
  { name: 'DNT', description: 'Do Not Track signal', values: ['1', '0'] },
  { name: 'x-api-key', description: 'Vendor API key (Postman / mock-servers / many gateways)' },
  {
    name: 'x-mock-match-request-body',
    description: 'Postman mock-server match flag',
    values: ['true', 'false'],
  },
  { name: 'x-mock-match-request-headers', description: 'Postman mock-server match flag' },
  { name: 'x-mock-response-id', description: 'Postman mock-server response id' },
];

/**
 * Case-insensitive lookup of a header definition by name. Returns undefined
 * for unknown / free-form header names — callers should treat the absence as
 * "no suggestions" rather than an error.
 */
export function getHeaderDef(name: string): HttpHeaderDef | undefined {
  const target = name.trim().toLowerCase();
  if (!target) return undefined;
  return STANDARD_HTTP_HEADERS.find((h) => h.name.toLowerCase() === target);
}
