# Restura Capability Matrix

> **Generated** from `src/lib/shared/capabilities.ts`. Do not edit by hand.
> CI fails if this file is stale; regenerate with `npm run capabilities:matrix`.

Restura ships as both a Cloudflare Pages SPA (web) and an Electron desktop
app from a single React renderer. Some features depend on capabilities the
browser sandbox doesn't expose (raw sockets, OS keychain, filesystem). This
table documents what works where so you can see the asymmetry at a glance
rather than discover it experimentally.

| Capability | Web | Desktop | Notes |
| --- | :-: | :-: | --- |
| HTTP / REST requests | ✅ | ✅ | Hosted web (Cloudflare Workers) sends only the runtime fixed method list (standard, WebDAV, PURGE, QUERY and a few more), upper-cased; other extension methods need desktop or self-host |
| GraphQL query / mutation | ✅ | ✅ | Rides the HTTP proxy: POST { query, variables, operationName } or, for queries, GET with them URL-encoded; sends Accept: application/graphql-response+json, application/json;q=0.9 |
| GraphQL @defer / @stream (multipart/mixed incremental delivery) | ✅ | ✅ | Both merge the multipart parts into one result. Web renders each part as it arrives (Worker streaming pass-through); desktop shows the merged result once the response completes (Electron HTTP IPC buffers) |
| SOCKS5 proxy | ❌ | ✅ | Browser fetch cannot route through SOCKS |
| PAC proxy script resolution | ❌ | ❌ | Not wired end-to-end: the renderer ProxyType cannot emit a PAC proxy and the PAC script is never loaded via session.setProxy — only handler scaffolding exists. Marked unsupported until the renderer + setProxy path land. |
| mTLS client certificates | ❌ | ✅ | Web build inherits browser cert store; no per-request control |
| Custom CA bundle | ❌ | ✅ |  |
| Manual redirect handling | ✅ | ✅ |  |
| DNS / connect timing breakdown | ❌ | ✅ | Both show time to headers, download and the remaining overhead; DNS and connect (incl. TLS) are measured only on desktop direct connections, not through proxies |
| DNS-pinning SSRF guard | ❌ | ✅ | Browser fetch resolves DNS opaquely |
| TLS cipher suite + server-order control | ❌ | ✅ | No per-request TLS handshake control in Cloudflare Workers / browsers |
| TLS minimum protocol version | ❌ | ✅ | Web client uses the runtime's default TLS floor |
| HTTP version control (force HTTP/1.1, HTTP/2, h2c prior knowledge) | ❌ | ✅ | Web always negotiates via the runtime (Auto). h2c prior knowledge works direct and through SOCKS, not through an HTTP proxy |
| Incremental HTTP response streaming | ✅ | ❌ | Web streams via the Worker proxy; Electron IPC buffers the full response (renderer falls back to the buffered path) |
| NTLM authentication | ❌ | ✅ | NTLMv2 handshake (type 1 → 2 → 3) on one pinned HTTP/1.1 connection, only for the requested origin; fails explicitly if the server drops the connection or HTTP/2 is required. Web and self-host send the request without authentication and the editor says so; the CLI refuses NTLM requests (#1069) |
| Load / performance testing | ✅ | ✅ | Fidelity differs: web is capped by ~6 browser connections per origin and the Worker proxy rate limit (100 req/min); desktop by the IPC rate budget. Results above those budgets include self-inflicted throttling |
| WebSocket connect | ✅ | ✅ |  |
| WebSocket custom request headers | ❌ | ✅ | Browser WS API forbids handshake headers; web connects directly and warns when headers would be dropped. The /api/ws-ticket → /api/ws Worker relay exists but is not wired into the renderer yet |
| WS through Worker (SSRF gate, header policy) | ❌ | ❌ | Worker routes exist (/api/ws-ticket, /api/ws) but the web renderer connects directly via the browser WebSocket API; desktop uses Node ws with the same guards |
| WebSocket ping / pong frames (with RTT) | ❌ | ✅ | The browser WebSocket API exposes no ping/pong control frames; web disables the Ping control with an explanatory tooltip. Custom close code/reason and the negotiated subprotocol/extensions work on both |
| Disable WebSocket permessage-deflate per connection | ❌ | ✅ | The browser always negotiates compression itself; desktop can turn the offer off |
| Server-Sent Events | ✅ | ✅ |  |
| SSE with custom headers | ✅ | ✅ | Web streams via the Worker /api/proxy (fetch-based, not EventSource), so custom headers are forwarded |
| MCP streamable-http / http-sse | ✅ | ✅ | http-sse transport is desktop-only; web supports streamable-http and rejects http-sse at connect time. Web runs the initialize/initialized handshake, MCP-Protocol-Version, DELETE on disconnect and one re-initialize on 404 session expiry, and surfaces server messages interleaved in a reply; it has no standalone GET listening stream and no Last-Event-ID resumption (desktop only) |
| MCP elicitation, sampling and roots (incl. 2026-07-28 input_required) | ❌ | ✅ | Server→client requests need a persistent channel back to the client; the web Worker proxy is request/response only. Desktop: form-mode elicitation (URL mode not advertised), sampling with per-request human approval (manual text or an AI-assistant provider draft), per-connection file:// roots with list_changed |
| MCP server notifications (progress, logging, list_changed, resources/updated) | ❌ | ✅ | Desktop streams server→client events over IPC into the Events pane and re-discovers on list_changed; on 2026-07-28 servers list_changed rides an auto-opened subscriptions/listen stream. The web Worker proxy is request/response only, so there is no server→client channel |
| MCP resource subscriptions | ❌ | ✅ | Subscribe/Unsubscribe toggle when the server advertises resources.subscribe; 2025-era servers use resources/subscribe, 2026-07-28 servers a per-resource subscriptions/listen stream (max 32 per connection). Needs the desktop server→client channel |
| MCP connection auth (Bearer / API-key header) | ✅ | ✅ | Desktop can store the credential as an OS-keychain or external SecretRef handle, resolved in the main process at connect time; web is inline-only and never persists the request’s own MCP credentials to IndexedDB (re-enter after reload). SecretRef-backed {{secret variables}} in MCP auth/headers are not resolved yet on either platform |
| MCP OAuth 2.1 sign-in (PKCE, PRM discovery, dynamic registration) | ❌ | ✅ | Desktop runs the flow in the main process: system browser + 127.0.0.1 loopback redirect, tokens kept only in the OS-keychain-encrypted secret store and refreshed automatically (ADR 0031). Web/self-host and the CLI do not run the browser sign-in — paste an access token as Bearer auth instead |
| MCP stdio transport (local server process) | ❌ | ✅ | Desktop main process spawns the command without a shell after a per-launch native consent prompt; the child gets an allowlisted environment, and is killed on disconnect/quit. Web and the CLI never spawn processes. Stdio items from a Postman v3 import arrive as disabled placeholders (argument and env values are not imported) and cannot be launched by the app or the CLI |
| Import MCP servers from Claude Desktop / Cursor / VS Code configs | ✅ | ✅ | Desktop reads the well-known config locations or a native file picker in the main process, stores credential-named stdio env values as secret handles, and imported stdio servers still need the per-launch consent prompt. Web accepts pasted or uploaded JSON (1 MB cap) and imports remote (HTTP) servers only; stdio entries are shown as desktop-only |
| MCP era/conformance report | ✅ | ✅ | Desktop connects in both protocol eras (legacy initialize and pinned modern 2026-07-28) and diffs them. Web runs the legacy era only: /api/mcp is a stateless JSON-RPC proxy with no era negotiation, so the modern era needs the desktop app or `restura mcp conformance` |
| gRPC unary + streaming | ✅ | ✅ | Web uses Connect transport (unary via /api/grpc; server-streaming connects directly, CORS permitting) — client/bidi streaming is desktop-only; desktop uses native gRPC with automatic Connect-protocol fallback |
| gRPC reflection | ✅ | ✅ | Web reflects Connect-protocol servers (v1 with v1alpha fallback) via /api/grpc/reflection; the bidi RPC needs an HTTP/2 upstream hop (self-host negotiates h2 over TLS) — gRPC-only servers need desktop |
| gRPC-Web wire protocol (per-request selector) | ✅ | ✅ | Unary + server-streaming to gRPC-Web endpoints (e.g. Envoy grpc_web); needs reflection or a .proto. Web/self-host relay via /api/grpc-web (binary or grpc-web-text, messages streamed as they arrive); desktop pins connect-node gRPC-Web (binary only). The same selector pins native gRPC (desktop only) or Connect. |
| Kafka produce / consume | ❌ | ✅ | Native broker protocol; no browser TCP |
| Kafka Confluent Schema Registry (subject produce, browse, decode) | ❌ | ✅ | Desktop main-process client: Basic or Bearer (SecretRef) auth, Settings TLS policy (custom CA, mTLS, verify) for HTTPS, broker-aligned SSRF policy (per-socket DNS checks refuse metadata and disabled loopback), no credentials over public plain HTTP; Avro/JSON Schema example generation, Protobuf view-only |
| Kafka SASL/OAUTHBEARER client-credentials (auto-refresh) | ❌ | ✅ | Token fetched in main through the SSRF-guarded, DNS-pinned fetch; https is required except for loopback hosts and private IP literals (private addresses still need the "allow private IPs" setting); refreshed once < max(30s, 25% of lifetime) remains; client secret is a kafka-scoped SecretRef handle |
| Kafka AWS MSK IAM | ❌ | ✅ | SigV4-presigned OAUTHBEARER token; access keys (SecretRef handles) or a named AWS profile; SASL_SSL only; brokers must be MSK hosts in the region unless explicitly opted out |
| Kafka SASL/GSSAPI (Kerberos) | ❌ | ❌ | Authenticator is implemented, but the native kerberos module is not bundled; the option is disabled in the form |
| MQTT publish / subscribe | ❌ | ✅ | Native broker protocol over raw TCP/TLS; no browser TCP |
| Socket.IO client | ✅ | ✅ |  |
| AI assistant (streaming chat) | ❌ | ✅ | Electron-only; tokens stream over IPC (ai:chat:chunk/end). No Worker /api/ai route |
| AI assistant tool calls | ❌ | ✅ | Provider tool-call decoding (OpenAI / Anthropic / OpenRouter) in the chat path |
| Inline AI actions (Fix request / Generate tests / Enrich docs) | ❌ | ✅ | One-click request/response actions that seed a chat send through the propose-&-apply harness; reuse the ai.basic IPC path |
| AI Agent Mode (multi-step, strict propose-&-apply) | ❌ | ✅ | Goal-driven loop over the existing ai:chat channel; one tool proposal per turn, every mutation user-approved, hard step cap. No new IPC/provider surface |
| AI Lab (prompt/model workbench) | ❌ | ✅ | Electron-only; model calls + SSRF localhost carve-out run in main |
| AI Lab local runtimes (Ollama / OpenAI-compatible) | ❌ | ✅ | Needs the localhost SSRF carve-out; no browser access to 127.0.0.1 |
| AI Lab dataset evals (deterministic + script + tool-call + pairwise scorers) | ❌ | ✅ | QuickJS scorers + bounded-concurrency runner over case × model cells; datasets from history/collections/CSV/JSONL/red-team, multi-turn cases |
| AI Lab LLM-as-judge (incl. pairwise/preference) | ❌ | ✅ | Structured-output judge call via the AI Lab complete path; pairwise with position-bias swap |
| AI Lab http-exec target (execute AI-generated request, score upstream response) | ❌ | ✅ | Model emits an HTTP/GraphQL request; executed via the real request executor (same SSRF guard), upstream response scored. See ADR 0023 |
| AI Lab Arena (pairwise model-vs-model Elo leaderboard) | ❌ | ✅ | Round-robin pairwise judging → Elo + win-rate matrix; persisted to the arenaRuns table |
| AI Lab agent suites (multi-step trials, trajectory/outcome evals) | ❌ | ✅ | AI Lab UI authoring and in-app execution are Electron-only, with one cancellable lifecycle per run surface; v3 suites add explicit selected grounding with provenance traces, task-aware grading, hard run-wide budgets, repeated-trial reliability, and sanitized bounded report persistence. `restura agent eval` supports OpenAI Responses, Anthropic Messages, and Git-native fixture bundles with fail-closed baseline gates. |
| AI Lab agent provider transports | ❌ | ✅ | Desktop wires OpenAI Chat, Anthropic Messages, OpenRouter, Ollama, Hugging Face, and generic OpenAI-compatible through cancellable keychain-backed IPC with conservative per-model capabilities and explicit user overrides. Headless CLI wires stateless OpenAI Responses and native Anthropic Messages. Gemini, Azure OpenAI, and Bedrock are adapter profiles only, not shipped transports. |
| AI Lab agents using saved Restura HTTP requests as tools | ❌ | ✅ | Runs through the normal request executor and security boundary with run-scoped cancellation; non-read methods require explicit per-call approval |
| AI Lab agents using MCP servers as tools | ❌ | ✅ | Uses saved encrypted MCP profiles with fresh desktop-owned sessions, existing SSRF/DNS pinning and execution policy, allowlists, cancellation, and per-call approval. CLI supports manifest-listed read-only MCP tools when CI explicitly asserts readOnly:true. |
| AI Lab pluggable code sandboxes | ❌ | ❌ | Unsupported: the provider contract and registry are implemented, but no Docker or hosted sandbox provider ships yet |
| Filesystem-backed collections | ❌ | ✅ |  |
| Git operations on collections | ❌ | ✅ | System-Git status, diff, staging, commits, branches, fetch/pull/push, and explicit resumable merges for registered OpenCollection directories; structured YAML conflict resolution validates before staging |
| Kafka / MQTT connection presets in collections | ❌ | ✅ | Save a Kafka or MQTT tab to a collection and reopen it prefilled; {{var}} resolved at send time. Presets round-trip through OpenCollection (x-restura-kafka / x-restura-mqtt) and git-native collections; credentials stay in the desktop secure store and are never exported. Web lists imported presets but opens the desktop-only panel; the CLI skips them. Postman v3 imports and exports carry Kafka / MQTT items (broker-only options such as SASL, TLS paths and schema registry are reported as not exported); the CLI still skips them without counting it as import loss |
| WebSocket / Socket.IO connections in collections | ✅ | ✅ | Save a WebSocket or Socket.IO tab to a collection and reopen it prefilled (URL, subprotocols / namespace / path, handshake headers, query and auth rows, reconnect options, subscribed events, composer draft and saved messages); {{var}} resolved at send time. OpenCollection: WebSocket is a native websocket item (Restura-only fields in x-restura-websocket), Socket.IO rides in x-restura-socketio; git-native collections round-trip. Postman v3 websocket-request / socket.io-request import as these items (older placeholder folders are upgraded) and export back. Not runnable: the collection runner and the CLI skip them with a notice; Postman v2.1 drops them (reported) and Insomnia / Bruno get named stubs. Export redaction blanks credential-named header / query rows, every literal Socket.IO handshake auth value and URL userinfo; these rows are stored as typed (not keychain handles), like the live connection |
| Postman v2.x / v3 import | ✅ | ✅ | Postman v2.0 / v2.1 JSON and v3 (a folder, a .zip, or a single JSON/YAML file) are auto-detected and parsed by one shared importer. Every dropped or approximated construct appears in an import report, and unmodelled data is kept in a store-scoped _postman sidecar (not in file-backed collections on disk; ADR 0034). Unsupported auth (hawk, jwt, edgegrid, asap, azure, sasl, akamai) imports as none with a warning (the raw auth is kept in the sidecar); WebSocket / Socket.IO items import as native collection items (collections.streamPresets); LLM / data items become placeholder folders; vault secret variables and v2.1 type: "secret" variables import value-less with a warning; archives are capped at 50 MB and path traversal is refused. An explicit Postman noauth is marked (_postman.noauth) and cuts inheritance, with an explicit-noauth import-report entry. Requests that would otherwise pick up an ancestor credential (an explicit noauth below a configured auth, or anything below a hawk / jwt / … folder or collection) are refused at send on web, desktop and the CLI: single sends of every protocol, the collection runner (skipped), workflows and AI Lab tools; before, only the CLI refused them. The CLI (restura run) accepts the same inputs, prints the report on stderr and in the json reporter, and --strict-import exits 2 on any report entry, including explicit-noauth |
| Postman export (v3 default, v2.1 single file) | ✅ | ✅ | Collection menu > Export: Postman v3 (folder / zip) is the default and listed first; Postman v2.1 (single file · Newman) is the Newman-compatible single-file option. v3: web and self-host download <name>.postman-v3.zip; desktop writes <picked>/<name>/, asks before replacing a non-empty folder and removes only Postman layout files. v2.1: one <name>.postman_collection.json download on every platform, valid against the v2.1.0 schema; all v2.1 auth types round-trip (basic, bearer, API key, digest, OAuth 1.0, OAuth 2.0, AWS SigV4, NTLM, no auth, inherit), and data kept from a v2.1 import (saved responses, protocolProfileBehavior, extra events, hawk / edgegrid auth, item and path variables, file paths) is restored. Both formats show an export report of what they cannot hold (v2.1: gRPC, SSE, MCP, WebSocket, Socket.IO, Kafka and MQTT items, WSSE and jwt / asap auth; both: secret variable values, keychain-stored secrets, Restura-only settings, and more). An explicit Postman noauth (kept from import) is exported as an explicit noauth block, never as inherit. Auth secrets follow the existing include-secrets prompt; with secrets excluded, credential-named form-body rows (urlencoded / form-data) and nested OAuth2 parameter rows are blanked too, in every exporter (Postman, Insomnia, OpenCollection, Bruno); keychain handles and secret variables are always exported empty. The CLI has no export command (#1204) |
| Workflows | ✅ | ✅ | Safe sequential, guarded, loop, and recovery controls execute with typed data/output, timeout/cancellation, and binding-only HTTP or GraphQL saved-request calls. GraphQL mutations require explicit approval. Other controls, event/process tasks, inline transport configuration, and unsupported transports are rejected before persistence or execution. |
| Local mock server | ❌ | ✅ | Binds a localhost HTTP listener; no browser TCP |
| Browser capture desktop bridge | ❌ | ✅ | Loopback receiver for the Restura capture extension; no browser TCP listener |
| OS keychain (safeStorage) for secrets | ❌ | ✅ | Web has no OS keychain; its default IndexedDB persistence is plaintext |
| Encrypted local storage | ❌ | ✅ | Desktop persistence uses safeStorage; web currently uses plaintext IndexedDB because the optional session-passphrase UI has not shipped |
| Native shell.openExternal | ❌ | ✅ |  |
| Native OS notifications | ❌ | ✅ |  |
| System tray icon | ❌ | ✅ |  |
| Pre-request / test scripts (rs.* sandbox) | ✅ | ✅ |  |
| rs.sendRequest sub-requests inside scripts | ✅ | ✅ | Routes through the same SSRF-guarded proxy as a top-level send |
| rs.cookies read/write against the cookie jar | ✅ | ✅ |  |
| rs.execution.setNextRequest / skipRequest runner flow control | ✅ | ✅ |  |
| rs.visualizer.set rendered in a sandboxed iframe tab | ✅ | ✅ |  |
| rs.vault encrypted key-value secret store | ❌ | ✅ | Backed by OS keychain via electron safeStorage; no equivalent in browser |
| rs.judge LLM-as-judge semantic assertions | ❌ | ✅ | Routes through the AI Lab complete IPC; no Worker /api/ai route yet |

---

To gate UI on a capability:

```tsx
import { CapabilityBadge } from '@/components/shared/CapabilityBadge';
<CapabilityBadge feature="http.mtls" />
```

To gate logic:

```ts
import { isCapableHere } from '@/lib/shared/capabilities';
import { isElectron } from '@/lib/shared/platform';
if (isCapableHere('http.proxy.socks', isElectron())) {
  // ...
}
```
