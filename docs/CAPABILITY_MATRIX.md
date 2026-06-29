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
| HTTP / REST requests | ✅ | ✅ |  |
| GraphQL query / mutation | ✅ | ✅ | Rides the HTTP proxy (POST { query, variables, operationName }) |
| SOCKS5 proxy | ❌ | ✅ | Browser fetch cannot route through SOCKS |
| PAC proxy script resolution | ❌ | ❌ | Not wired end-to-end: the renderer ProxyType cannot emit a PAC proxy and the PAC script is never loaded via session.setProxy — only handler scaffolding exists. Marked unsupported until the renderer + setProxy path land. |
| mTLS client certificates | ❌ | ✅ | Web build inherits browser cert store; no per-request control |
| Custom CA bundle | ❌ | ✅ |  |
| Manual redirect handling | ✅ | ✅ |  |
| DNS-pinning SSRF guard | ❌ | ✅ | Browser fetch resolves DNS opaquely |
| TLS cipher suite + server-order control | ❌ | ✅ | No per-request TLS handshake control in Cloudflare Workers / browsers |
| WebSocket connect | ✅ | ✅ |  |
| WebSocket custom request headers | ✅ | ✅ | Web build proxies through /api/ws-ticket → /api/ws since browser WS API forbids headers |
| WS through Worker (SSRF gate, header policy) | ✅ | ❌ | Desktop uses Node ws directly with the same guards |
| Server-Sent Events | ✅ | ✅ |  |
| SSE with custom headers | ❌ | ✅ | EventSource API in browsers has no headers option |
| MCP streamable-http / http-sse | ✅ | ✅ |  |
| MCP stdio (local subprocess) | ❌ | ✅ |  |
| gRPC unary + streaming | ✅ | ✅ | Web uses Connect transport over HTTP/2; desktop uses native gRPC with automatic Connect-protocol fallback |
| gRPC reflection | ✅ | ✅ |  |
| Kafka produce / consume | ❌ | ✅ | Native broker protocol; no browser TCP |
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
| Filesystem-backed collections | ❌ | ✅ |  |
| Git operations on collections | ❌ | ✅ |  |
| Local mock server | ❌ | ✅ | Binds a localhost HTTP listener; no browser TCP |
| Browser capture desktop bridge | ❌ | ✅ | Loopback receiver for the Restura capture extension; no browser TCP listener |
| OS keychain (safeStorage) for secrets | ❌ | ✅ | Web falls back to encrypted IndexedDB |
| Encrypted local storage | ✅ | ✅ |  |
| Native shell.openExternal | ❌ | ✅ |  |
| Native OS notifications | ❌ | ✅ |  |
| System tray icon | ❌ | ✅ |  |
| rs.sendRequest sub-requests inside scripts | ✅ | ✅ | Routes through the same SSRF-guarded proxy as a top-level send |
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
