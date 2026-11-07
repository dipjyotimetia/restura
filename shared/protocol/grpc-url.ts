/**
 * gRPC / Connect / gRPC-Web route URLs are `<base>/<service>/<method>` and
 * carry no query, so build them via `URL` — never by string concatenation,
 * which puts the path after a `?query` / `#fragment` in the base. Shared by
 * the call proxies, the reflection proxy and the renderer's direct Connect
 * transport so every backend targets the same route.
 */

/** `url` with search + hash dropped and trailing slashes trimmed. Throws on an unparsable URL. */
export function grpcBaseUrl(url: string): string {
  const target = new URL(url);
  target.search = '';
  target.hash = '';
  target.pathname = target.pathname.replace(/\/+$/, '');
  return target.toString().replace(/\/+$/, '');
}

/** The `<base>/<service>/<method>` route for `url` (query/fragment dropped). */
export function grpcMethodUrl(url: string, service: string, method: string): string {
  return `${grpcBaseUrl(url)}/${service}/${method}`;
}
