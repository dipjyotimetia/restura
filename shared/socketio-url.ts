/**
 * The URL handed to Socket.IO's `io()`, joined with the namespace.
 *
 * The connect guards (the desktop SSRF check and the browser private-network
 * check) read the host with the WHATWG URL parser, but `io()` parses with its
 * own parser, which reads some unusual URLs differently. Passing the WHATWG
 * serialisation means both always see the same host.
 *
 * Socket.IO joins a namespace by appending it to the URL's path, so a
 * non-default namespace replaces any path on the base URL. Throws when `rawUrl`
 * doesn't parse.
 */
export function socketIoConnectUrl(rawUrl: string, namespace: string | undefined): string {
  const url = new URL(rawUrl);
  if (!namespace || namespace === '/') return url.href;
  const ns = namespace.startsWith('/') ? namespace : `/${namespace}`;
  // Concatenate rather than resolve: `new URL('//other.host', origin)` would
  // treat the namespace as a protocol-relative URL and change the host.
  return new URL(`${url.origin}${ns}`).href;
}
