/**
 * Capability matrix (Gap #10). Single source of truth for which features
 * work on which target. Read by:
 *
 *   - the `<CapabilityBadge>` component (renders "Desktop only" tags)
 *   - the doc generator at `scripts/generate-capability-matrix.ts` (writes
 *     `docs/CAPABILITY_MATRIX.md`; CI checks for drift)
 *
 * Keep keys stable — they're referenced by `<CapabilityBadge feature="...">`.
 */

export type CapabilityName =
  | 'http.basic'
  | 'http.proxy.socks'
  | 'http.proxy.pac'
  | 'http.mtls'
  | 'http.customCa'
  | 'http.manualRedirect'
  | 'http.dnsPinning'
  | 'http.tls.cipherSuite'
  | 'http.tls.minVersion'
  | 'websocket.basic'
  | 'websocket.customHeaders'
  | 'websocket.viaWorkerProxy'
  | 'sse.basic'
  | 'sse.customHeaders'
  | 'mcp.basic'
  | 'mcp.stdioLocalProcess'
  | 'grpc.basic'
  | 'grpc.reflection'
  | 'kafka.basic'
  | 'socketio.basic'
  | 'collections.file'
  | 'collections.git'
  | 'mock.localServer'
  | 'storage.osKeychain'
  | 'storage.encryptedLocal'
  | 'native.shell'
  | 'native.notifications'
  | 'native.tray'
  | 'scripts.basic'
  | 'scripts.sendRequest'
  | 'scripts.cookies'
  | 'scripts.setNextRequest'
  | 'scripts.visualizer'
  | 'scripts.vault';

export interface CapabilityRow {
  /** Display label for docs/UI. */
  label: string;
  /** Whether this works in the Cloudflare Pages SPA. */
  web: boolean;
  /** Whether this works in the Electron desktop build. */
  desktop: boolean;
  notes?: string;
}

export const CAPABILITIES: Record<CapabilityName, CapabilityRow> = {
  'http.basic': { label: 'HTTP / REST requests', web: true, desktop: true },
  'http.proxy.socks': {
    label: 'SOCKS5 proxy',
    web: false,
    desktop: true,
    notes: 'Browser fetch cannot route through SOCKS',
  },
  'http.proxy.pac': { label: 'PAC proxy script resolution', web: false, desktop: true },
  'http.mtls': {
    label: 'mTLS client certificates',
    web: false,
    desktop: true,
    notes: 'Web build inherits browser cert store; no per-request control',
  },
  'http.customCa': { label: 'Custom CA bundle', web: false, desktop: true },
  'http.manualRedirect': { label: 'Manual redirect handling', web: true, desktop: true },
  'http.dnsPinning': {
    label: 'DNS-pinning SSRF guard',
    web: false,
    desktop: true,
    notes: 'Browser fetch resolves DNS opaquely',
  },
  'http.tls.cipherSuite': {
    label: 'TLS cipher suite + server-order control',
    web: false,
    desktop: true,
    notes: 'No per-request TLS handshake control in Cloudflare Workers / browsers',
  },
  'http.tls.minVersion': {
    label: 'TLS minimum protocol version',
    web: false,
    desktop: true,
    notes: "Web client uses the runtime's default TLS floor",
  },
  'websocket.basic': { label: 'WebSocket connect', web: true, desktop: true },
  'websocket.customHeaders': {
    label: 'WebSocket custom request headers',
    web: true,
    desktop: true,
    notes:
      'Web build proxies through /api/ws-ticket → /api/ws since browser WS API forbids headers',
  },
  'websocket.viaWorkerProxy': {
    label: 'WS through Worker (SSRF gate, header policy)',
    web: true,
    desktop: false,
    notes: 'Desktop uses Node ws directly with the same guards',
  },
  'sse.basic': { label: 'Server-Sent Events', web: true, desktop: true },
  'sse.customHeaders': {
    label: 'SSE with custom headers',
    web: false,
    desktop: true,
    notes: 'EventSource API in browsers has no headers option',
  },
  'mcp.basic': { label: 'MCP streamable-http / http-sse', web: true, desktop: true },
  'mcp.stdioLocalProcess': { label: 'MCP stdio (local subprocess)', web: false, desktop: true },
  'grpc.basic': {
    label: 'gRPC unary + streaming',
    web: true,
    desktop: true,
    notes: 'Web uses Connect transport over HTTP/2',
  },
  'grpc.reflection': { label: 'gRPC reflection', web: true, desktop: true },
  'kafka.basic': {
    label: 'Kafka produce / consume',
    web: false,
    desktop: true,
    notes: 'Native broker protocol; no browser TCP',
  },
  'socketio.basic': { label: 'Socket.IO client', web: true, desktop: true },
  'collections.file': { label: 'Filesystem-backed collections', web: false, desktop: true },
  'collections.git': { label: 'Git operations on collections', web: false, desktop: true },
  'mock.localServer': {
    label: 'Local mock server',
    web: false,
    desktop: true,
    notes: 'Binds a localhost HTTP listener; no browser TCP',
  },
  'storage.osKeychain': {
    label: 'OS keychain (safeStorage) for secrets',
    web: false,
    desktop: true,
    notes: 'Web falls back to encrypted IndexedDB',
  },
  'storage.encryptedLocal': { label: 'Encrypted local storage', web: true, desktop: true },
  'native.shell': { label: 'Native shell.openExternal', web: false, desktop: true },
  'native.notifications': { label: 'Native OS notifications', web: false, desktop: true },
  'native.tray': { label: 'System tray icon', web: false, desktop: true },
  'scripts.basic': {
    label: 'Pre-request / test scripts (pm.* sandbox)',
    web: true,
    desktop: true,
  },
  'scripts.sendRequest': {
    label: 'pm.sendRequest sub-requests inside scripts',
    web: true,
    desktop: true,
    notes: 'Routes through the same SSRF-guarded proxy as a top-level send',
  },
  'scripts.cookies': {
    label: 'pm.cookies read/write against the cookie jar',
    web: true,
    desktop: true,
  },
  'scripts.setNextRequest': {
    label: 'pm.execution.setNextRequest / skipRequest runner flow control',
    web: true,
    desktop: true,
  },
  'scripts.visualizer': {
    label: 'pm.visualizer.set rendered in a sandboxed iframe tab',
    web: true,
    desktop: true,
  },
  'scripts.vault': {
    label: 'pm.vault encrypted key-value secret store',
    web: false,
    desktop: true,
    notes: 'Backed by OS keychain via electron safeStorage; no equivalent in browser',
  },
};

export function isCapableHere(name: CapabilityName, isElectron: boolean): boolean {
  const row = CAPABILITIES[name];
  return isElectron ? row.desktop : row.web;
}
