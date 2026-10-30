// Single source of truth for the stable ports the local echo stack binds.
// The launcher, manifest, and generated collection all read their port numbers
// from here (each composes its own URL form — bare host:port for the gRPC
// client, schemed URLs for humans). Ports are deliberately fixed (not ephemeral)
// so the installed/dev desktop client can be pointed at them by hand and a
// generated collection can hardcode them.

export const PORTS = {
  /** Plain HTTP echo + the full OAuth2/JWT/SigV4/Digest/API-key surface. */
  http: 8080,
  /** HTTPS with a CA-signed server leaf (no client cert required). */
  https: 8443,
  /** HTTPS that demands a client cert — mutual TLS. */
  mtls: 8444,
  /** Cleartext HTTP/2 — prior knowledge only (h2c, RFC 9113 §3.3). Pair with
   *  the request's HTTP version = "HTTP/2 cleartext (h2c)" setting. */
  h2c: 8090,
  /** HTTP/2 over TLS (ALPN h2 + http/1.1) — try forcing HTTP/1.1 against it. */
  h2: 8446,
  /** Forward + CONNECT HTTP proxy. */
  proxy: 8888,
  /** SOCKS5 CONNECT proxy for raw TCP clients such as MQTT. */
  socks: 1080,
  /** Native gRPC (h2c) + server reflection — what the DESKTOP client dials. */
  grpc: 50051,
  /** WebSocket (/echo /chat /graphql /ping /close). */
  ws: 8085,
  /** Secure WebSocket — same paths over TLS (CA-signed). The packaged desktop
   *  CSP allows wss: but not ws:, so this is the only WS the packaged app can dial. */
  wss: 8543,
  /** Socket.IO (/ /chat /admin). */
  socketio: 8086,
  /** MCP streamable-http (2025-era SDK, stateless — one server per request). */
  mcp: 8087,
  /** MCP on the v2 SDK: modern `server/discover` era with legacy fallback,
   *  resource subscriptions + list_changed pushes (#858, #872). */
  mcpV2: 8088,
  /** OAuth 2.1 authorization server for the MCP auth flow (#856): RFC 8414
   *  metadata, RFC 7591 dynamic registration, auto-approving PKCE S256
   *  /authorize, /token (authorization_code + refresh_token). */
  mcpOAuthAs: 8089,
  /** OAuth-protected MCP resource paired with :8089 — answers 401 +
   *  `WWW-Authenticate: Bearer resource_metadata=…` until a valid token arrives. */
  mcpOAuthResource: 8093,
  /** graphql-sse (distinct-connections mode) subscription endpoint (#889). */
  graphqlSse: 8091,
  /** Apollo `subscriptions-transport-ws` (legacy `graphql-ws` subprotocol) (#889). */
  graphqlWsLegacy: 8092,
  /** MQTT over TCP (EMQX via docker-compose — not started in-process). */
  mqtt: 1883,
  /** MQTT over TLS (EMQX built-in self-signed cert). */
  mqtts: 8883,
  /** MQTT over WebSocket (EMQX, path /mqtt). */
  mqttWs: 8083,
  /** MQTT over secure WebSocket (EMQX self-signed cert, path /mqtt). */
  mqttWss: 8084,
  /** EMQX dashboard (admin / public). */
  mqttDashboard: 18083,
  /** Kafka PLAINTEXT (Redpanda via docker-compose — not started in-process). */
  kafka: 9092,
  /** Kafka SSL (TLS, no SASL — self-signed cert, verify-SSL off). */
  kafkaSsl: 9093,
  /** Kafka SASL_PLAINTEXT (SCRAM-SHA-256/512). */
  kafkaSasl: 9094,
  /** Kafka SASL_SSL (SCRAM over TLS — self-signed cert, verify-SSL off). */
  kafkaSaslSsl: 9095,
  /** Confluent-compatible Schema Registry (bundled with Redpanda). */
  schemaRegistry: 8081,
} as const;

/** Services the launcher can start in-process (Kafka + MQTT are Docker-only). */
export const IN_PROCESS_SERVICES = [
  'http',
  'https',
  'mtls',
  'h2c',
  'h2',
  'proxy',
  'socks',
  'grpc',
  'ws',
  'wss',
  'socketio',
  'mcp',
  'mcpV2',
  'mcpOAuth',
  'graphqlSse',
  'graphqlWsLegacy',
] as const;

export type ServiceId = (typeof IN_PROCESS_SERVICES)[number];

/**
 * Services skipped entirely when `--no-tls` is passed (they need cert material).
 */
export const TLS_SERVICES: ReadonlySet<ServiceId> = new Set(['https', 'mtls', 'h2', 'wss']);

export const DEFAULT_HOST = 'localhost';
