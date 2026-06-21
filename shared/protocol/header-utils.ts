/**
 * Helpers for the `Record<string, string> | Headers` union shape used by
 * `FetcherRequest.headers` (see types.ts). The union exists because the
 * redirect follower needs the standard Headers API for case-insensitive
 * cross-origin credential stripping; flatteners convert back when a
 * downstream library (undici, etc.) only accepts a plain object.
 */

/**
 * Convert `Headers | Record<string, string>` to a plain `Record<string, string>`.
 * Pass-through when input is already a record. Used by `undici`-backed fetchers
 * (CLI, Electron) and by tests that assert on header values.
 */
export function flattenHeaders(
  headers: Headers | Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  return headers;
}
