// Source of truth for the hostname is echo/wrangler.jsonc routes[0].pattern.
export const ECHO_BASE = 'https://echo.restura.dev';

export const ECHO_URLS = {
  http: `${ECHO_BASE}/anything`,
  grpc: ECHO_BASE,
  graphql: `${ECHO_BASE}/graphql`,
  websocket: 'wss://echo.restura.dev/ws',
  sse: `${ECHO_BASE}/sse`,
} as const;
