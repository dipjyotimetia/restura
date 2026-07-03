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
  | 'http.streamingResponse'
  | 'loadTesting.basic'
  | 'websocket.basic'
  | 'websocket.customHeaders'
  | 'websocket.viaWorkerProxy'
  | 'sse.basic'
  | 'sse.customHeaders'
  | 'mcp.basic'
  | 'mcp.stdioLocalProcess'
  | 'grpc.basic'
  | 'grpc.reflection'
  | 'grpc.clientAndBidiStreaming'
  | 'grpc.tlsOverrides'
  | 'grpc.compression'
  | 'kafka.basic'
  | 'mqtt.basic'
  | 'socketio.basic'
  | 'ai.basic'
  | 'ai.toolCalls'
  | 'ai.inlineActions'
  | 'ai.agentMode'
  | 'aiLab.basic'
  | 'aiLab.localProviders'
  | 'aiLab.evals'
  | 'aiLab.judge'
  | 'aiLab.httpExec'
  | 'aiLab.arena'
  | 'collections.file'
  | 'collections.git'
  | 'mock.localServer'
  | 'capture.desktopBridge'
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
  'http.streamingResponse': {
    label: 'Incremental HTTP response streaming',
    web: true,
    desktop: false,
    notes:
      'Web streams via the Worker proxy; Electron IPC buffers the full response (renderer falls back to the buffered path)',
  },
  'loadTesting.basic': {
    label: 'Load / performance testing',
    web: true,
    desktop: true,
    notes:
      'Fidelity differs: web is capped by ~6 browser connections per origin and the Worker proxy rate limit (100 req/min); desktop by the IPC rate budget. Results above those budgets include self-inflicted throttling',
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
    label: 'gRPC unary + server-streaming',
    web: true,
    desktop: true,
    notes:
      'Web uses Connect transport over HTTP/2 (unary via the Worker proxy, server-streaming direct from the browser); desktop uses native gRPC with automatic Connect-protocol fallback. See grpc.clientAndBidiStreaming for the two method types web cannot run at all.',
  },
  'grpc.reflection': { label: 'gRPC reflection', web: true, desktop: true },
  'grpc.clientAndBidiStreaming': {
    label: 'gRPC client-streaming / bidirectional-streaming',
    web: false,
    desktop: true,
    notes:
      'Browser fetch cannot duplex a request body; unary and server-streaming still work on web.',
  },
  'grpc.tlsOverrides': {
    label: 'gRPC custom CA / client cert / verify-SSL',
    web: false,
    desktop: true,
    notes:
      'Settings → Certificates overrides apply to HTTP only on web — the Worker proxy has no per-request TLS control for gRPC, so an mTLS-only or private-CA gRPC server that works over HTTP will not work over gRPC on the same web build.',
  },
  'grpc.compression': { label: 'gRPC gzip request compression', web: false, desktop: true },
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
  'ai.inlineActions': {
    label: 'Inline AI actions (Fix request / Generate tests / Enrich docs)',
    web: false,
    desktop: true,
    notes:
      'One-click request/response actions that seed a chat send through the propose-&-apply harness; reuse the ai.basic IPC path',
  },
  'ai.agentMode': {
    label: 'AI Agent Mode (multi-step, strict propose-&-apply)',
    web: false,
    desktop: true,
    notes:
      'Goal-driven loop over the existing ai:chat channel; one tool proposal per turn, every mutation user-approved, hard step cap. No new IPC/provider surface',
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
    label: 'AI Lab dataset evals (deterministic + script + tool-call + pairwise scorers)',
    web: false,
    desktop: true,
    notes:
      'QuickJS scorers + bounded-concurrency runner over case × model cells; datasets from history/collections/CSV/JSONL/red-team, multi-turn cases',
  },
  'aiLab.judge': {
    label: 'AI Lab LLM-as-judge (incl. pairwise/preference)',
    web: false,
    desktop: true,
    notes:
      'Structured-output judge call via the AI Lab complete path; pairwise with position-bias swap',
  },
  'aiLab.httpExec': {
    label: 'AI Lab http-exec target (execute AI-generated request, score upstream response)',
    web: false,
    desktop: true,
    notes:
      'Model emits an HTTP/GraphQL request; executed via the real request executor (same SSRF guard), upstream response scored. See ADR 0023',
  },
  'aiLab.arena': {
    label: 'AI Lab Arena (pairwise model-vs-model Elo leaderboard)',
    web: false,
    desktop: true,
    notes: 'Round-robin pairwise judging → Elo + win-rate matrix; persisted to the arenaRuns table',
  },
  'collections.file': { label: 'Filesystem-backed collections', web: false, desktop: true },
  'collections.git': { label: 'Git operations on collections', web: false, desktop: true },
  'mock.localServer': {
    label: 'Local mock server',
    web: false,
    desktop: true,
    notes: 'Binds a localhost HTTP listener; no browser TCP',
  },
  'capture.desktopBridge': {
    label: 'Browser capture desktop bridge',
    web: false,
    desktop: true,
    notes: 'Loopback receiver for the Restura capture extension; no browser TCP listener',
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
