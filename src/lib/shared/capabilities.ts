/**
 * Capability matrix (Gap #10). Single source of truth for which features
 * work on which target. Read by:
 *
 *   - the `<CapabilityBadge>` component (renders "Desktop only" tags)
 *   - the doc generator at `scripts/generate-capability-matrix.mjs` (writes
 *     `docs/CAPABILITY_MATRIX.md`; CI checks for drift)
 *
 * Keep keys stable — they're referenced by `<CapabilityBadge feature="...">`.
 */

export type CapabilityName =
  | 'http.basic'
  | 'graphql.basic'
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
  | 'mqtt.basic'
  | 'socketio.basic'
  | 'ai.basic'
  | 'ai.toolCalls'
  | 'aiLab.basic'
  | 'aiLab.localProviders'
  | 'aiLab.evals'
  | 'aiLab.judge'
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
  | 'scripts.vault'
  | 'scripts.judge';

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
  'graphql.basic': {
    label: 'GraphQL query / mutation',
    web: true,
    desktop: true,
    notes: 'Rides the HTTP proxy (POST { query, variables, operationName })',
  },
  'http.proxy.socks': {
    label: 'SOCKS5 proxy',
    web: false,
    desktop: true,
    notes: 'Browser fetch cannot route through SOCKS',
  },
  'http.proxy.pac': {
    label: 'PAC proxy script resolution',
    web: false,
    desktop: false,
    notes:
      'Not wired end-to-end: the renderer ProxyType cannot emit a PAC proxy and the PAC script is never loaded via session.setProxy — only handler scaffolding exists. Marked unsupported until the renderer + setProxy path land.',
  },
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
    notes:
      'Web uses Connect transport over HTTP/2; desktop uses native gRPC with automatic Connect-protocol fallback',
  },
  'grpc.reflection': { label: 'gRPC reflection', web: true, desktop: true },
  'kafka.basic': {
    label: 'Kafka produce / consume',
    web: false,
    desktop: true,
    notes: 'Native broker protocol; no browser TCP',
  },
  'mqtt.basic': {
    label: 'MQTT publish / subscribe',
    web: false,
    desktop: true,
    notes: 'Native broker protocol over raw TCP/TLS; no browser TCP',
  },
  'socketio.basic': { label: 'Socket.IO client', web: true, desktop: true },
  'ai.basic': {
    label: 'AI assistant (streaming chat)',
    web: false,
    desktop: true,
    notes: 'Electron-only; tokens stream over IPC (ai:chat:chunk/end). No Worker /api/ai route',
  },
  'ai.toolCalls': {
    label: 'AI assistant tool calls',
    web: false,
    desktop: true,
    notes: 'Provider tool-call decoding (OpenAI / Anthropic / OpenRouter) in the chat path',
  },
  'aiLab.basic': {
    label: 'AI Lab (prompt/model workbench)',
    web: false,
    desktop: true,
    notes: 'Electron-only; model calls + SSRF localhost carve-out run in main',
  },
  'aiLab.localProviders': {
    label: 'AI Lab local runtimes (Ollama / OpenAI-compatible)',
    web: false,
    desktop: true,
    notes: 'Needs the localhost SSRF carve-out; no browser access to 127.0.0.1',
  },
  'aiLab.evals': {
    label: 'AI Lab dataset evals (deterministic + script scorers)',
    web: false,
    desktop: true,
    notes: 'QuickJS scorers + bounded-concurrency runner over case × model cells',
  },
  'aiLab.judge': {
    label: 'AI Lab LLM-as-judge',
    web: false,
    desktop: true,
    notes: 'Structured-output judge call via the AI Lab complete path',
  },
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
    label: 'Pre-request / test scripts (rs.* sandbox)',
    web: true,
    desktop: true,
  },
  'scripts.sendRequest': {
    label: 'rs.sendRequest sub-requests inside scripts',
    web: true,
    desktop: true,
    notes: 'Routes through the same SSRF-guarded proxy as a top-level send',
  },
  'scripts.cookies': {
    label: 'rs.cookies read/write against the cookie jar',
    web: true,
    desktop: true,
  },
  'scripts.setNextRequest': {
    label: 'rs.execution.setNextRequest / skipRequest runner flow control',
    web: true,
    desktop: true,
  },
  'scripts.visualizer': {
    label: 'rs.visualizer.set rendered in a sandboxed iframe tab',
    web: true,
    desktop: true,
  },
  'scripts.vault': {
    label: 'rs.vault encrypted key-value secret store',
    web: false,
    desktop: true,
    notes: 'Backed by OS keychain via electron safeStorage; no equivalent in browser',
  },
  'scripts.judge': {
    label: 'rs.judge LLM-as-judge semantic assertions',
    web: false,
    desktop: true,
    notes: 'Routes through the AI Lab complete IPC; no Worker /api/ai route yet',
  },
};

export function isCapableHere(name: CapabilityName, isElectron: boolean): boolean {
  const row = CAPABILITIES[name];
  return isElectron ? row.desktop : row.web;
}
