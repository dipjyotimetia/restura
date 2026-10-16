/**
 * Proxy wire constants shared by the backends (`http-proxy.ts`, the Worker's
 * `/api/proxy`) and the renderer transport. Kept dependency-free so the
 * renderer can import them without pulling the proxy orchestrator into the
 * bundle.
 */

/** Largest upstream body the proxy buffers (and the renderer accepts streamed). */
export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

/**
 * Set by the proxy on a streamed pass-through response that came from the
 * upstream. A streamed `/api/proxy` reply without it is the proxy's own JSON
 * error (validation, SSRF refusal, auth gate), which otherwise looks exactly
 * like an upstream response with the same status.
 */
export const PROXY_STREAM_MARKER_HEADER = 'x-restura-proxy-stream';

/**
 * Stamped by the proxy on every `/api/*` reply it produces — its own errors
 * included. Together with the marker it disambiguates a streamed reply:
 * capability header present + no marker ⇒ the proxy's own error; capability
 * header absent ⇒ an older proxy (version skew) whose replies are ambiguous
 * and are kept as the upstream's response rather than guessed at.
 */
export const PROXY_CAPABILITY_HEADER = 'x-restura-proxy';

/**
 * The upstream's real status code / reason phrase on a streamed reply. The
 * proxy answers statuses the browser would act on itself (3xx redirects,
 * 401 / 407 auth prompts) with 200 and carries the real one here; the
 * renderer transport restores it before any consumer sees the response.
 */
export const PROXY_UPSTREAM_STATUS_HEADER = 'x-restura-upstream-status';
export const PROXY_UPSTREAM_STATUS_TEXT_HEADER = 'x-restura-upstream-status-text';

/**
 * Upstream response headers withheld from the streamed reply because the
 * browser would act on them against the Restura origin (see
 * `STREAM_FORWARD_DENY` in header-policy.ts), carried as a JSON object so the
 * renderer can still show them.
 */
export const PROXY_UPSTREAM_HEADERS_HEADER = 'x-restura-upstream-headers';

/** Every `x-restura-*` header the proxy itself writes on a streamed reply. */
export const PROXY_STREAM_SIDE_CHANNEL_PREFIX = 'x-restura-';

/** Statuses the browser handles natively (follows / prompts) — masked to 200. */
export function isBrowserActionableStatus(status: number): boolean {
  return (status >= 300 && status < 400) || status === 401 || status === 407;
}

/** JSON-encode a header side-channel value, escaping non-ASCII for the wire. */
export function encodeHeaderSideChannel(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}
