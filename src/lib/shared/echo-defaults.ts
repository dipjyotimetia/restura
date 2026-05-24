// Source of truth for the hostname is echo/wrangler.jsonc routes[0].pattern.
// Self-hosted Docker builds can override every URL via VITE_ECHO_* env vars
// at build time (see vite.config.mts) so internal-only deployments don't
// surface placeholders that resolve to the public echo server.
const ECHO_BASE = 'https://echo.restura.dev';

function withFallback(override: string | undefined, fallback: string): string {
  return override && override.length > 0 ? override : fallback;
}

export const ECHO_URLS = {
  http: withFallback(import.meta.env.VITE_ECHO_HTTP_URL, `${ECHO_BASE}/anything`),
  grpc: withFallback(import.meta.env.VITE_ECHO_GRPC_URL, ECHO_BASE),
  graphql: withFallback(import.meta.env.VITE_ECHO_GRAPHQL_URL, `${ECHO_BASE}/graphql`),
  websocket: withFallback(import.meta.env.VITE_ECHO_WS_URL, 'wss://echo.restura.dev/ws'),
  sse: withFallback(import.meta.env.VITE_ECHO_SSE_URL, `${ECHO_BASE}/sse`),
} as const;
