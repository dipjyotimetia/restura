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
  /** Forward + CONNECT HTTP proxy. */
  proxy: 8888,
  /** Native gRPC (h2c) + server reflection — what the DESKTOP client dials. */
  grpc: 50051,
  /** WebSocket (/echo /chat /graphql /ping /close). */
  ws: 8085,
  /** Secure WebSocket — same paths over TLS (CA-signed). The packaged desktop
   *  CSP allows wss: but not ws:, so this is the only WS the packaged app can dial. */
  wss: 8543,
  /** Socket.IO (/ /chat /admin). */
  socketio: 8086,
  /** MCP streamable-http. */
  mcp: 8087,
  /** MQTT over TCP (EMQX via docker-compose — not started in-process). */
  mqtt: 1883,
  /** MQTT over TLS (EMQX built-in self-signed cert). */
  mqtts: 8883,
  /** EMQX dashboard (admin / public). */
  mqttDashboard: 18083,
  /** Kafka API (Apache Kafka KRaft via docker-compose — not started in-process). */
  kafka: 9092,
} as const;

/** Services the launcher can start in-process (Kafka + MQTT are Docker-only). */
export const IN_PROCESS_SERVICES = [
  'http',
  'https',
  'mtls',
  'proxy',
  'grpc',
  'ws',
  'wss',
  'socketio',
  'mcp',
] as const;

export type ServiceId = (typeof IN_PROCESS_SERVICES)[number];

/**
 * Services skipped entirely when `--no-tls` is passed (they need cert material).
 */
export const TLS_SERVICES: ReadonlySet<ServiceId> = new Set(['https', 'mtls', 'wss']);

export const DEFAULT_HOST = 'localhost';
