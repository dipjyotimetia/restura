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
  | 'graphql.incrementalDelivery'
  | 'http.proxy.socks'
  | 'http.proxy.pac'
  | 'http.mtls'
  | 'http.customCa'
  | 'http.manualRedirect'
  | 'http.dnsPinning'
  | 'http.connectionTimings'
  | 'http.tls.cipherSuite'
  | 'http.tls.minVersion'
  | 'http.version'
  | 'http.streamingResponse'
  | 'loadTesting.basic'
  | 'websocket.basic'
  | 'websocket.customHeaders'
  | 'websocket.viaWorkerProxy'
  | 'websocket.ping'
  | 'websocket.perMessageDeflateToggle'
  | 'sse.basic'
  | 'sse.customHeaders'
  | 'mcp.basic'
  | 'mcp.clientRequests'
  | 'mcp.serverNotifications'
  | 'mcp.resourceSubscriptions'
  | 'mcp.auth'
  | 'mcp.oauth'
  | 'grpc.basic'
  | 'grpc.reflection'
  | 'grpc.web'
  | 'kafka.basic'
  | 'kafka.schemaRegistry'
  | 'kafka.saslOAuthRefresh'
  | 'kafka.saslMskIam'
  | 'kafka.saslGssapi'
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
  | 'aiLab.agentSuites'
  | 'aiLab.agentProviders'
  | 'aiLab.agentRequestTools'
  | 'aiLab.agentMcpTools'
  | 'aiLab.agentSandboxes'
  | 'collections.file'
  | 'collections.git'
  | 'collections.brokerPresets'
  | 'workflows.ows'
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
  'http.basic': {
    label: 'HTTP / REST requests',
    web: true,
    desktop: true,
    notes:
      'Hosted web (Cloudflare Workers) sends only the runtime fixed method list (standard, WebDAV, PURGE, QUERY and a few more), upper-cased; other extension methods need desktop or self-host',
  },
  'graphql.basic': {
    label: 'GraphQL query / mutation',
    web: true,
    desktop: true,
    notes:
      'Rides the HTTP proxy: POST { query, variables, operationName } or, for queries, GET with them URL-encoded; sends Accept: application/graphql-response+json, application/json;q=0.9',
  },
  'graphql.incrementalDelivery': {
    label: 'GraphQL @defer / @stream (multipart/mixed incremental delivery)',
    web: true,
    desktop: true,
    notes:
      'Both merge the multipart parts into one result. Web renders each part as it arrives (Worker streaming pass-through); desktop shows the merged result once the response completes (Electron HTTP IPC buffers)',
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
  'http.connectionTimings': {
    label: 'DNS / connect timing breakdown',
    web: false,
    desktop: true,
    notes:
      'Both show time to headers, download and the remaining overhead; DNS and connect (incl. TLS) are measured only on desktop direct connections, not through proxies',
  },
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
  'http.version': {
    label: 'HTTP version control (force HTTP/1.1, HTTP/2, h2c prior knowledge)',
    web: false,
    desktop: true,
    notes:
      'Web always negotiates via the runtime (Auto). h2c prior knowledge works direct and through SOCKS, not through an HTTP proxy',
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
    web: false,
    desktop: true,
    notes:
      'Browser WS API forbids handshake headers; web connects directly and warns when headers would be dropped. The /api/ws-ticket → /api/ws Worker relay exists but is not wired into the renderer yet',
  },
  'websocket.viaWorkerProxy': {
    label: 'WS through Worker (SSRF gate, header policy)',
    web: false,
    desktop: false,
    notes:
      'Worker routes exist (/api/ws-ticket, /api/ws) but the web renderer connects directly via the browser WebSocket API; desktop uses Node ws with the same guards',
  },
  'websocket.ping': {
    label: 'WebSocket ping / pong frames (with RTT)',
    web: false,
    desktop: true,
    notes:
      'The browser WebSocket API exposes no ping/pong control frames; web disables the Ping control with an explanatory tooltip. Custom close code/reason and the negotiated subprotocol/extensions work on both',
  },
  'websocket.perMessageDeflateToggle': {
    label: 'Disable WebSocket permessage-deflate per connection',
    web: false,
    desktop: true,
    notes: 'The browser always negotiates compression itself; desktop can turn the offer off',
  },
  'sse.basic': { label: 'Server-Sent Events', web: true, desktop: true },
  'sse.customHeaders': {
    label: 'SSE with custom headers',
    web: true,
    desktop: true,
    notes:
      'Web streams via the Worker /api/proxy (fetch-based, not EventSource), so custom headers are forwarded',
  },
  'mcp.basic': {
    label: 'MCP streamable-http / http-sse',
    web: true,
    desktop: true,
    notes:
      'http-sse transport is desktop-only; web supports streamable-http and rejects http-sse at connect time. Web runs the initialize/initialized handshake, MCP-Protocol-Version, DELETE on disconnect and one re-initialize on 404 session expiry, and surfaces server messages interleaved in a reply; it has no standalone GET listening stream and no Last-Event-ID resumption (desktop only)',
  },
  'mcp.clientRequests': {
    label: 'MCP elicitation, sampling and roots (incl. 2026-07-28 input_required)',
    web: false,
    desktop: true,
    notes:
      'Server→client requests need a persistent channel back to the client; the web Worker proxy is request/response only. Desktop: form-mode elicitation (URL mode not advertised), sampling with per-request human approval (manual text or an AI-assistant provider draft), per-connection file:// roots with list_changed',
  },
  'mcp.serverNotifications': {
    label: 'MCP server notifications (progress, logging, list_changed, resources/updated)',
    web: false,
    desktop: true,
    notes:
      'Desktop streams server→client events over IPC into the Events pane and re-discovers on list_changed; on 2026-07-28 servers list_changed rides an auto-opened subscriptions/listen stream. The web Worker proxy is request/response only, so there is no server→client channel',
  },
  'mcp.resourceSubscriptions': {
    label: 'MCP resource subscriptions',
    web: false,
    desktop: true,
    notes:
      'Subscribe/Unsubscribe toggle when the server advertises resources.subscribe; 2025-era servers use resources/subscribe, 2026-07-28 servers a per-resource subscriptions/listen stream (max 32 per connection). Needs the desktop server→client channel',
  },
  'mcp.auth': {
    label: 'MCP connection auth (Bearer / API-key header)',
    web: true,
    desktop: true,
    notes:
      'Desktop can store the credential as an OS-keychain or external SecretRef handle, resolved in the main process at connect time; web is inline-only and never persists the request’s own MCP credentials to IndexedDB (re-enter after reload). SecretRef-backed {{secret variables}} in MCP auth/headers are not resolved yet on either platform',
  },
  'mcp.oauth': {
    label: 'MCP OAuth 2.1 sign-in (PKCE, PRM discovery, dynamic registration)',
    web: false,
    desktop: true,
    notes:
      'Desktop runs the flow in the main process: system browser + 127.0.0.1 loopback redirect, tokens kept only in the OS-keychain-encrypted secret store and refreshed automatically (ADR 0031). Web/self-host and the CLI do not run the browser sign-in — paste an access token as Bearer auth instead',
  },
  'grpc.basic': {
    label: 'gRPC unary + streaming',
    web: true,
    desktop: true,
    notes:
      'Web uses Connect transport (unary via /api/grpc; server-streaming connects directly, CORS permitting) — client/bidi streaming is desktop-only; desktop uses native gRPC with automatic Connect-protocol fallback',
  },
  'grpc.reflection': {
    label: 'gRPC reflection',
    web: true,
    desktop: true,
    notes:
      'Web reflects Connect-protocol servers (v1 with v1alpha fallback) via /api/grpc/reflection; the bidi RPC needs an HTTP/2 upstream hop (self-host negotiates h2 over TLS) — gRPC-only servers need desktop',
  },
  'grpc.web': {
    label: 'gRPC-Web wire protocol (per-request selector)',
    web: true,
    desktop: true,
    notes:
      'Unary + server-streaming to gRPC-Web endpoints (e.g. Envoy grpc_web); needs reflection or a .proto. Web/self-host relay via /api/grpc-web (binary or grpc-web-text, messages streamed as they arrive); desktop pins connect-node gRPC-Web (binary only). The same selector pins native gRPC (desktop only) or Connect.',
  },
  'kafka.basic': {
    label: 'Kafka produce / consume',
    web: false,
    desktop: true,
    notes: 'Native broker protocol; no browser TCP',
  },
  'kafka.schemaRegistry': {
    label: 'Kafka Confluent Schema Registry (subject produce, browse, decode)',
    web: false,
    desktop: true,
    notes:
      'Desktop main-process client: Basic or Bearer (SecretRef) auth, Settings TLS policy (custom CA, mTLS, verify) for HTTPS, broker-aligned SSRF policy (per-socket DNS checks refuse metadata and disabled loopback), no credentials over public plain HTTP; Avro/JSON Schema example generation, Protobuf view-only',
  },
  'kafka.saslOAuthRefresh': {
    label: 'Kafka SASL/OAUTHBEARER client-credentials (auto-refresh)',
    web: false,
    desktop: true,
    notes:
      'Token fetched in main through the SSRF-guarded, DNS-pinned fetch; https is required except for loopback hosts and private IP literals (private addresses still need the "allow private IPs" setting); refreshed once < max(30s, 25% of lifetime) remains; client secret is a kafka-scoped SecretRef handle',
  },
  'kafka.saslMskIam': {
    label: 'Kafka AWS MSK IAM',
    web: false,
    desktop: true,
    notes:
      'SigV4-presigned OAUTHBEARER token; access keys (SecretRef handles) or a named AWS profile; SASL_SSL only; brokers must be MSK hosts in the region unless explicitly opted out',
  },
  'kafka.saslGssapi': {
    label: 'Kafka SASL/GSSAPI (Kerberos)',
    web: false,
    desktop: false,
    notes:
      'Authenticator is implemented, but the native kerberos module is not bundled; the option is disabled in the form',
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
  'aiLab.agentSuites': {
    label: 'AI Lab agent suites (multi-step trials, trajectory/outcome evals)',
    web: false,
    desktop: true,
    notes:
      'AI Lab UI authoring and in-app execution are Electron-only, with one cancellable lifecycle per run surface; v3 suites add explicit selected grounding with provenance traces, task-aware grading, hard run-wide budgets, repeated-trial reliability, and sanitized bounded report persistence. `restura agent eval` supports OpenAI Responses, Anthropic Messages, and Git-native fixture bundles with fail-closed baseline gates.',
  },
  'aiLab.agentProviders': {
    label: 'AI Lab agent provider transports',
    web: false,
    desktop: true,
    notes:
      'Desktop wires OpenAI Chat, Anthropic Messages, OpenRouter, Ollama, Hugging Face, and generic OpenAI-compatible through cancellable keychain-backed IPC with conservative per-model capabilities and explicit user overrides. Headless CLI wires stateless OpenAI Responses and native Anthropic Messages. Gemini, Azure OpenAI, and Bedrock are adapter profiles only, not shipped transports.',
  },
  'aiLab.agentRequestTools': {
    label: 'AI Lab agents using saved Restura HTTP requests as tools',
    web: false,
    desktop: true,
    notes:
      'Runs through the normal request executor and security boundary with run-scoped cancellation; non-read methods require explicit per-call approval',
  },
  'aiLab.agentMcpTools': {
    label: 'AI Lab agents using MCP servers as tools',
    web: false,
    desktop: true,
    notes:
      'Uses saved encrypted MCP profiles with fresh desktop-owned sessions, existing SSRF/DNS pinning and execution policy, allowlists, cancellation, and per-call approval. CLI supports manifest-listed read-only MCP tools when CI explicitly asserts readOnly:true.',
  },
  'aiLab.agentSandboxes': {
    label: 'AI Lab pluggable code sandboxes',
    web: false,
    desktop: false,
    notes:
      'Unsupported: the provider contract and registry are implemented, but no Docker or hosted sandbox provider ships yet',
  },
  'collections.file': { label: 'Filesystem-backed collections', web: false, desktop: true },
  'collections.git': {
    label: 'Git operations on collections',
    web: false,
    desktop: true,
    notes:
      'System-Git status, diff, staging, commits, branches, fetch/pull/push, and explicit resumable merges for registered OpenCollection directories; structured YAML conflict resolution validates before staging',
  },
  'collections.brokerPresets': {
    label: 'Kafka / MQTT connection presets in collections',
    web: false,
    desktop: true,
    notes:
      'Save a Kafka or MQTT tab to a collection and reopen it prefilled; {{var}} resolved at send time. Presets round-trip through OpenCollection (x-restura-kafka / x-restura-mqtt) and git-native collections; credentials stay in the desktop secure store and are never exported. Web lists imported presets but opens the desktop-only panel; the CLI skips them',
  },
  'workflows.ows': {
    label: 'Workflows',
    web: true,
    desktop: true,
    notes:
      'Safe sequential, guarded, loop, and recovery controls execute with typed data/output, timeout/cancellation, and binding-only HTTP or GraphQL saved-request calls. GraphQL mutations require explicit approval. Other controls, event/process tasks, inline transport configuration, and unsupported transports are rejected before persistence or execution.',
  },
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
    notes: 'Web has no OS keychain; its default IndexedDB persistence is plaintext',
  },
  'storage.encryptedLocal': {
    label: 'Encrypted local storage',
    web: false,
    desktop: true,
    notes:
      'Desktop persistence uses safeStorage; web currently uses plaintext IndexedDB because the optional session-passphrase UI has not shipped',
  },
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
