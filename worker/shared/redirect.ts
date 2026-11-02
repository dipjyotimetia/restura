/**
 * Upstream redirects are never followed by the gRPC / MCP / WebSocket routes:
 * URL validation (and the Node DNS guard) only cover the first hop, so a 3xx
 * to another host would bypass them. Fetchers pass `redirect: 'manual'` and
 * run the response through `rejectRedirect`.
 *
 * Runtimes differ on what a manual redirect looks like: Node/undici returns
 * the real 3xx, workerd may return status 0 / type 'opaqueredirect'.
 */
export function isRedirectResponse(r: { status: number; type?: string }): boolean {
  return (r.status >= 300 && r.status < 400) || r.status === 0 || r.type === 'opaqueredirect';
}

/** Describes a redirect for error messages. */
export function redirectMessage(status: number, what: string): string {
  const code = status > 0 ? ` (HTTP ${status})` : '';
  return `Upstream redirected${code}; redirects are not followed for ${what}. Update the URL to its final address.`;
}

/** Throws (and discards the body) when the upstream answered with a redirect. */
export function rejectRedirect(r: Response, what: string): Response {
  if (isRedirectResponse(r)) {
    void r.body?.cancel().catch(() => {});
    throw new Error(redirectMessage(r.status, what));
  }
  return r;
}
