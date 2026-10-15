/**
 * Proxy wire constants shared by the backends (`http-proxy.ts`) and the
 * renderer transport. Kept dependency-free so the renderer can import them
 * without pulling the proxy orchestrator into the bundle.
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
