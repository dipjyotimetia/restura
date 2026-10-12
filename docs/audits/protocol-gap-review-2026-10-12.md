# Protocol gap review — 2026-10-12

Scope: the 9 wire protocols (HTTP, GraphQL, gRPC, WebSocket, Socket.IO, SSE, Kafka, MQTT, MCP client) plus `docs-site/`. Baseline commit `0fc6c5f6`; security reviewed as a delta since `57cd0c3f` plus never-audited areas.

Gap types in scope: **spec completeness**, **cross-cutting product features** (auth, `{{vars}}`, scripts, history, collections, import/export, CLI, mock, codegen), **security/robustness**, **docs accuracy/coverage**. Benchmarks: protocol specs (primary), Postman / Insomnia / Bruno (+ Hoppscotch/MQTTX for realtime, Kafka UI/Conduktor for Kafka) as candidate gaps. Web/desktop harness parity and `capabilities.ts` claim-drift were **out of scope** (appendix only).

Severity: **P0** security or broken for a common case · **P1** commonly-used spec feature missing · **P2** rare spec / competitor-only · **P3** polish. Docs: P1 false claim / wrong security behaviour · P2 shipped-but-undocumented · P3 wording/links.

Every gap is **confirmed** by a repro test (assertions pin today's broken behaviour — flip them when fixing) or a file:line absence trace, unless marked *suspected*. Repro tests live in uncommitted agent worktrees under `.claude/worktrees/agent-*/` (paths in §9).

## Spec versions checked

| Protocol | Baseline |
|---|---|
| HTTP | RFC 9110 / 9112 / 9113, RFC 6265 |
| GraphQL | Spec Oct 2021 + draft; GraphQL-over-HTTP draft; graphql-transport-ws (graphql-ws v5/6); subscriptions-transport-ws; incremental-delivery RFC |
| gRPC | PROTOCOL-HTTP2.md, PROTOCOL-WEB.md, Connect v1, reflection v1/v1alpha, `google.rpc.Status` |
| WebSocket | RFC 6455, RFC 7692 |
| Socket.IO | v4 client (Engine.IO v4 / Socket.IO protocol v5) |
| SSE | WHATWG HTML §9.2 |
| Kafka | Protocol as exposed by @platformatic/kafka 2.12.1; Confluent Schema Registry |
| MQTT | 3.1.1 (2014), 5.0 (2019); mqtt.js 5.16 |
| MCP | 2026-07-28 (SDK 2.2.0 latest); also 2025-11-25 / 2025-06-18 / 2024-11-05 |

## 1. Security findings

### Private advisories (details withheld from this public report)

| ID | Class | Harness | Sev |
|---|---|---|---|
| ADV-1 | Self-host/Worker auth gate trusts an identity header without cryptographic verification in CF-Access mode | Worker, Node/Docker | P0 |
| ADV-2 | Broker SSRF guard can be bypassed by non-canonical host forms | Electron (Kafka, MQTT) | P0 |
| ADV-3 | Upstream redirect not re-validated on the MCP proxy route | Worker, Node/Docker | P0 (self-host) |
| ADV-4 | Upstream redirect can bypass DNS pinning for the MCP SDK transport | Electron | P0 |

ADV-3/ADV-4 sit in code the 2026-06-21 audit considered settled — treat as a regression class and add a cross-protocol "every outbound fetch is `redirect:'manual'` or per-hop validated" security test.

### Public (non-advisory)

| ID | Finding | Sev | Evidence |
|---|---|---|---|
| SEC-W1 | Web WebSocket, Socket.IO, GraphQL subscriptions (and gRPC server-streaming) connect browser-direct; the private-network policy doesn't apply and credentials travel in `connection_init`, including over `ws://`. Not server-side SSRF (no capability beyond any web page), but undocumented policy divergence | P2 | `websocketManager.ts:89`, `socketioManager.ts:207`, `subscriptionClient.ts:63`, CSP `public/_headers:8` |
| SEC-S1 | Socket.IO Connect writes the `{{var}}`-resolved URL back into the persisted store (template lost, secret persisted in plaintext) | P1 | `SocketIOClient.tsx:276-280`, `useSocketIOStore.ts:358` |
| SEC-G1 | Hostile gRPC server can OOM the desktop main process (unary uncapped; connect `readMaxBytes` default 4 GiB; decompression accepted) | P2 | `grpc-connect.ts` `executeConnectUnary`, `buildNodeTransportBase` |
| SEC-G2 | Worker gRPC reflection / proxy read bodies unbounded when chunked | P3 | `worker/handlers/grpc-reflection.ts`, `grpc-proxy.ts` |
| SEC-K1 | Kafka/MQTT hostnames that resolve to private IPs pass under `allowPrivateIPs:false` (no DNS-time check) | P2 | `kafka-broker-guard.ts`, `mqtt-broker-guard.ts` |
| SEC-K2 | Kafka checks only the first bootstrap broker against proxy policy | P3 | `broker-execution-policy.ts:112-120` |
| SEC-K3 | Kafka/MQTT credentials: encrypted sentinel, not SecretRef — renderer handles plaintext; TLS keys read in renderer | P3 | `kafkaManager.ts:93,138`, `mqttManager.ts:63,93` |
| SEC-X1 | Bruno export writes every environment in the store (other collections' non-secret values leak; secrets withheld) | P2 | `useCollectionSidebarCommands.ts:150-152` |
| SEC-X2 | History stores raw request unredacted (inline `Authorization`, gRPC metadata, resolved URL, `Set-Cookie`) | P2 | `useHistoryStore.ts:56-62` |
| SEC-X3 | Plaintext persistence of WS headers, Socket.IO auth, SSE inline auth, MCP headers (web: plaintext Dexie) | P2 | `useWebSocketStore.ts:376-385`, `useSocketIOStore.ts:353-371` |
| SEC-X4 | CLI `--reporter json` serialises request auth (pre-resolution) | P3 | `cli/src/reporters/json.ts:12` |

## 2. Cross-cutting matrix

Y supported · P partial · N missing.

| Proto | Auth on wire | `{{var}}` | Scripts | History | Collection save | OC round-trip | Postman/Insomnia/Bruno | CLI | Mock | Codegen |
|---|---|---|---|---|---|---|---|---|---|---|
| HTTP | Y (not Digest/NTLM) | Y | Y | Y | Y | P (OAuth1/NTLM/WSSE lost) | Y | Y | Y | Y |
| GraphQL | Y | P (subs) | Y (q/m) | P | Y (as HTTP) | Y | Y | Y | via HTTP | P (unwired) |
| gRPC | P | P | P (unary) | P (unary) | Y | Y | N | **broken on desktop runner** | N | N |
| SSE | P | P | N app / Y CLI | N | **broken** | **lossy** | N | Y | N | unwired |
| MCP | N | P | N app / Y CLI | N | **broken** | **lossy** | N | **ping only** | N | unwired |
| WebSocket | N | P (URL) | N | N | N | placeholder | N | N (unrouted) | N | unwired |
| Socket.IO | P | P (URL, written back) | N | N | N | root `_oc` | N | N | N | N |
| Kafka | Y | **N** | N | N | N | N | N | N | N | N |
| MQTT | Y | **N** | N | N | N | N | N | N | N | N |

## 3. Gaps — P0

| ID | Gap | Evidence | Repro |
|---|---|---|---|
| WS-1 | Desktop WebSocket binary frames broken both directions (hex vs base64 mismatch across IPC) | `websocketManager.ts:237-241,300-303`; `websocket-handler.ts:199-207,283-285` | `ws-electron-gaps.test.ts` |
| XC-1 | OpenCollection export (and desktop Save-to-Files) drops SSE scripts/params/`reconnectOnResume` and MCP `defaultMethod`/`defaultParams`/scripts | `from-internal.ts:390-409`, `to-internal.ts:544-597` | `xcut-oc-roundtrip.test.ts` |
| XC-3 | OAuth1 / NTLM / WSSE auth becomes `none` on OC export+import | `from-internal.ts:476-519` | `xcut-oc-roundtrip.test.ts` |
| XC-4 | "Save to Collection" stores the default request for SSE/MCP (P1 for WS/SIO/Kafka/MQTT empty placeholder) | `SaveToCollectionDialog.tsx:~136` | trace |
| XC-5 | CLI MCP can only send `ping` (method/params never persisted) | `cli/src/runner/executors/mcp.ts:57` | `xcut-oc-roundtrip.test.ts` |
| GRPC-1 | Desktop collection runner fails every gRPC request (no schema on `GrpcRequest`) | `collectionRunner.ts:314`, `shared/types/grpc.ts:23-36` | `grpc-runner-desktop.test.ts` |
| GRPC-2 | Web gRPC reflection fails against any standard Connect server (un-enveloped JSON → 415; works only against echo shim) | `worker/handlers/grpc-reflection.ts:38-45` | `grpc-web-reflection.test.ts` |

## 4. Gaps — P1

| ID | Protocol | Gap | Evidence |
|---|---|---|---|
| HTTP-1 | HTTP | Multiple `Set-Cookie` collapsed on every backend (cookie jar + view lose cookies) | `header-policy.ts:46-52`, `requestExecutor.ts:353` |
| GQL-1 | GraphQL | Regex op-type detection: leading comment / fragment-first sends a subscription as POST | `queryParser.ts:193` |
| GQL-3 | GraphQL | Subscription auth: `{{vars}}` unresolved, inherited auth ignored | `GraphQLRequestBuilder.tsx:126` |
| GQL-4 | GraphQL | SecretRef-handle auth and API-key-in-query dropped on subscriptions | `GraphQLRequestBuilder.tsx:126-127` |
| GRPC-3 | gRPC | Streams killed at 30 s deadline / 5-min absolute sweep; swept stream sends no final event (UI stuck "streaming") | `grpc-handler.ts` `cleanupStaleStreams` |
| GRPC-4 | gRPC | Rich error details (`grpc-status-details-bin`) never decoded | `grpc-connect.ts`, `grpc-proxy.ts` |
| GRPC-5 | gRPC | Reflection can't send metadata/auth | `ReflectionIpcConfigSchema` (`core.ts:471`) |
| GRPC-6 | gRPC | Uploaded `.proto` with imports (incl. WKT) fails | `grpc-registry.ts` `registryFromProtoText` |
| GRPC-7 | gRPC | 1 KB per-header cap rejects ordinary JWTs | `grpcClient.ts` MAX_HEADER_SIZE |
| GRPC-8 | gRPC | SigV4/OAuth1/WSSE/Digest/NTLM silently send unauthenticated | `grpcClient.ts` `buildAuthMetadata` |
| WS-2 | WebSocket | Desktop ignores auto-reconnect and heartbeat | `websocketManager.ts:306-316,385-397` |
| WS-3 | WebSocket | Disconnect during desktop handshake is a no-op; late open flips UI to connected | `websocketManager.ts:202,290` |
| SIO-1 | Socket.IO | Server-requested acks never answered (desktop may drop the event — *suspected*) | `socketio-handler.ts:281-285`, `socketioManager.ts:291-298` |
| SIO-3 | Socket.IO | No UI for path, extraHeaders, transports, reconnection, timeout, forceNew | `SocketIOClient.tsx:428-444` |
| SSE-1 | SSE | CRLF split across chunks fabricates an event boundary (all harnesses) | `sse-parser.ts:62-63` |
| SSE-2 | SSE | No automatic reconnect; `retry` parsed but unused | `sseManager.ts:178-182,241-248` |
| KAFKA-1 | Kafka | No OAUTHBEARER refresh, GSSAPI, or AWS MSK IAM (library supports them) | `kafka-handler.ts:92-98,174-189` |
| MQTT-1 | MQTT | No MQTT-over-WebSocket (`ws://`/`wss://`) | `validators/mqtt.ts:10-26` |
| MQTT-2 | MQTT | Binary payloads/correlation data UTF-8-decoded (bytes lost); publish string-only | `mqtt-handler.ts:178,191` |
| MQTT-3 | MQTT | v5 subscription options stripped | `validators/mqtt.ts:123-127` |
| MCP-1 | MCP | No stdio transport | `ipc/validators/core.ts:699` |
| MCP-2 | MCP | No OAuth 2.1 (PKCE/PRM/DCR); `McpRequest.auth` never read | `protocol.ts:29,99-103` |
| MCP-3 | MCP | Notifications / close / error never reach the UI (progress, logs, list_changed dropped; stays "connected") | `mcp-handler.ts:185-210`, no `mcp.on` in `src/` |
| MCP-4 | MCP | Sampling, elicitation, roots unsupported (`input_required` tools fail) | `mcp-sdk-client.ts:51-54` |
| MCP-5 | MCP | Web pins `initialize` to 2024-11-05 and never sends `notifications/initialized` | `mcpClient.ts:229-245` |
| MCP-7 | MCP | Result badge green for `CallToolResult.isError: true` | `McpResultPanel.tsx:6` |
| XC-2 | SSE, MCP | Foldered SSE/MCP hoisted to root on OC export (folder auth/scripts lost) | `from-internal.ts:284-290` |
| XC-6 | WebSocket | Not runnable in CLI (executor unrouted); OC WS items silently skipped | `dispatch.ts:19-31` |
| XC-7 | WS, SIO, MQTT, gRPC-stream | Can't be saved to collections | `shared/types/request.ts:7,25` |
| XC-8 | Kafka, MQTT, WS, SIO, GQL-sub, MCP | No `{{var}}` substitution in payloads/headers/topics | see agent report |
| XC-9 | gRPC, SSE, MCP, WS | Auth silently dropped for unsupported types (no notice) | `SseClient.tsx:106-110`, `mcp/protocol.ts:29` |

## 5. Gaps — P2 / P3 (condensed)

- **HTTP/GraphQL** — GQL-2 operationName regex / no multi-op selector (P2); GQL-5 no `@defer`/`@stream`, `application/graphql-response+json`, GET (P2); GQL-6 no legacy subscriptions-transport-ws / graphql-sse (P2); HTTP-2 custom methods rejected (P2); COMP-1 Digest/NTLM unimplemented — known (P2); COMP-2 no HTTP-version control (P2); COMP-3 no SDL import (P2); GQL-7 introspection options (P3); HTTP-3 zstd / stacked encodings on desktop (P3, *suspected*).
- **gRPC** — GRPC-9 qualified types skipped by regex parser (P2); GRPC-10 scripts can't see metadata/trailers (P2); GRPC-11 no gRPC-Web transport (P2); GRPC-12 streaming has no scripts/history/retry (P2); GRPC-13 proto/timeout not persisted, no BSR (P2); GRPC-14 unknown JSON fields silently dropped (P3).
- **WebSocket/Socket.IO/SSE** — WS-4 bad hex silently sent (P2); WS-5 no close code/reason (P2); WS-6 no ping/pong (P2); WS-7 extensions not shown (P3); WS-8 `{{vars}}` not resolved in messages (P2); WS-9 no saved templates / scripts (P2); SIO-4 flat auth only (P2); SIO-5 per-emit options (P2); SIO-6 `reconnect*` event names over-reserved (P3); SIO-7 no incoming size cap (P2, *suspected*); SSE-3 id-only block doesn't update Last-Event-ID (P2); SSE-4 empty id not reset (P3); SSE-5 lax `retry` parsing (P3).
- **Kafka/MQTT** — KAFKA-2 Schema Registry ignores TLS policy, Basic only (P2); KAFKA-3 numeric schemaId only (P2); KAFKA-4 browsing creates/commits a group (P2); KAFKA-5 limited offset reset (P2); KAFKA-6 per-record renderer flush, no backpressure (P2); KAFKA-7 no per-partition pause/seek (P3); KAFKA-8 IPv6 brokers rejected (P3); MQTT-4 will properties (P2); MQTT-5 payload format / topic alias (P2); MQTT-6 DISCONNECT reason / reconnect events not forwarded (P2); MQTT-7 other v5 CONNECT props, empty clientId (P3); MQTT-8 request/response helper (P3).
- **MCP** — MCP-6 web no `MCP-Protocol-Version` header (P2); MCP-8 subscriptions (P2); MCP-9 templates/completion/logging have no UI (P2); MCP-10 outputSchema/annotations not shown (P2); MCP-11 no user cancel (P2); MCP-12 web session lifecycle (P3); MCP-13 competitor parity (P2, *suspected*).
- **Cross-cutting** — XC-10 scripts only for HTTP/GQL/unary gRPC in-app (P2); XC-11 streaming writes no history (P2); XC-12 Postman/Insomnia/Bruno non-HTTP stubbed / silently coerced (P2); XC-13 mock HTTP-only (P3); XC-14 WS/SSE/MCP/GraphQL code generators + HAR/OpenAPI exporters have no callers (P3).

## 6. Docs findings

Site health: `docs:build`, `docs:check`, `docs:test`, `capabilities:check` all **pass**; 0 broken links/anchors, 0 orphans. Caveat: `reference/capability-matrix.mdx` is hand-written and **not gated** by `capabilities:check`.

### P1 — false claims / wrong security behaviour (batched per page)

| Page | Claims to fix |
|---|---|
| `protocols/websocket.mdx` | auth on connect; binary upload/script; ping/pong visible; auto-reconnect (desktop no-op); history/replay; script assertions; binary send (broken on desktop) |
| `protocols/socket-io.mdx` | path/reconnect/transports/forceNew/extraHeaders configurable; "Listen — subscribe"; script assertions |
| `protocols/sse.mdx` | `pm.test` on event payloads |
| `protocols/graphql.mdx` | persisted queries; operation switcher; paste SDL; Cmd+Shift+F |
| `protocols/http.mdx` | any custom verb; Protobuf body |
| `protocols/grpc.mdx` | imports resolved; FileDescriptorSet upload; SigV4 at wire; web reflection parity |
| `protocols/kafka.mdx`, `mqtt.mdx` | private/loopback brokers "allowed" (blocked by default); metadata block presented as complete (don't publish ADV-2 details); MQTT binary payloads |
| `protocols/mcp.mdx` | streamed results; resource subscriptions; "URL validation + DNS pinning apply" (first hop only — ADV-4, don't publish details); `input_required` fails outright |
| `reference/opencollection.mdx`, `guides/import-export.mdx` | "lossless" round-trip; WS/Socket.IO covered; every auth scheme; OpenAPI export in menu; exports redacted by default |
| `guides/ai-assistant.mdx`, `architecture/security.mdx`, `index.mdx`, `what-is-restura.mdx` (+ ADR 0010) | AI prompt host redaction — full URL is sent |
| `self-hosting/{reverse-proxy,docker,install}.mdx` | `REQUIRE_CF_ACCESS` "skips the token check" (token check runs first); header trust guidance (tied to ADV-1) |
| `what-is-restura.mdx`, `overview/comparison.mdx` | MCP server mode presented as working (context loader returns empty) |

### P2 / P3

- P2: `capability-matrix.mdx`/`platforms.mdx` "SSRF guard on all upstream requests" (web browser-direct paths); `reference/cli.mdx` MCP "single JSON-RPC POST" (always ping), nonexistent "File → Export → OpenCollection directory", desktop runner skip list; `kafka.mdx` omits OAUTHBEARER; `mqtt.mdx` publish-side v5 properties; `grpc.mdx` traceparent "disable" setting.
- P2 undocumented shipped features: Kafka admin/producer/consumer depth; gRPC compression/timeout/retry/TLS/scripts/Web Stream tab; HTTP streaming viewer + ALPN display; GraphQL SDL download/explorer insert; MCP read-resource/get-prompt/pagination/workflows/codegen; importers (cURL, HAR, `.http`, Postman env); external secret providers; rs.judge / rs.vault; network console + response diff; visualizer; deep links; agent telemetry export.
- P3: workflow wording stale; "same-origin" Worker (cross-origin in prod — CLAUDE.md too); dev bypass needs `ENVIRONMENT=development`; wrong MCP-server redactor path; Docker env table missing `HTTP(S)_PROXY`/`NO_PROXY`/`RATE_LIMITER`/`DEV_BYPASS_AUTH`; npm version mismatch (contributing vs engines 12.1.0); ADR links point at index; contract-test wording; Kafka compression/clientId defaults; WS redirects same-host only; gRPC web-binary wording.

Roadmap tree: no false "shipped" statuses; MCP and GraphQL-subscription descriptions gloss over web limits.

## 7. Opportunities (self-discovered; not ranked as gaps)

| # | Idea | Type | Area | Evidence |
|---|---|---|---|---|
| O-1 | **Unified streaming timeline** — WS/SIO/SSE/Kafka/MQTT in one filterable, exportable, correlatable view | unique | streaming | console store already mirrors WS/SSE frames (`useSseStore.ts:202`) |
| O-2 | **Stream assertions in QuickJS** — `rs.test` per frame/event ("assert within N events"), reusing the CLI's `streamEvents` context; makes several false docs claims true | both | streaming, CLI | `cli/src/reporters/types.ts` |
| O-3 | **Saved message/emit templates with `{{var}}`** | ergonomic | WS/SIO/MQTT | WS-8, WS-9 |
| O-4 | **AST GraphQL operation picker** with auto-routed transport | ergonomic | GraphQL | `queryParser.ts:148,193` |
| O-5 | **Click-through GraphQL errors** — map `errors[].path/locations` to editor + response tree | unique | GraphQL | `GraphQLRequestBuilder.tsx:262-280` |
| O-6 | **Wire the dead code generators** (WS/SSE/MCP/GraphQL) + add `grpcurl`/`buf curl` | ergonomic | all | `codeGenerators/index.ts:12-18` |
| O-7 | **gRPC schema snapshot + drift diff** on re-reflect (also fixes GRPC-1) | unique | gRPC | `reflectionClient.fetchDescriptorClosure` |
| O-8 | **Map `google.rpc.BadRequest` field violations onto the request editor** | both | gRPC | GRPC-4 |
| O-9 | **Strict-send lint** — warn on unknown fields before send | ergonomic | gRPC | `ignoreUnknownFields: true` |
| O-10 | **MQTT 5 request/response mode** with round-trip latency | unique | MQTT | fields exist (`validators/mqtt.ts:118-120`) |
| O-11 | **Read-only Kafka "Browse topic"** — group-less, no commits | ergonomic | Kafka | KAFKA-4 |
| O-12 | **Schema Registry subject picker** | ergonomic | Kafka | KAFKA-3 |
| O-13 | **Kafka/MQTT connection presets as collection items** | unique | Kafka/MQTT | sentinel storage already exists |
| O-14 | **MCP server tests in collections + CI** | unique | MCP | `runJsonRpc` exists; `runRequest` throws (`protocol.ts:232`) |
| O-15 | **Import `mcp.json`** from Claude Desktop / Cursor / VS Code | ergonomic | MCP | pairs with MCP-1 |
| O-16 | **MCP era/conformance report** — run legacy vs modern, diff, validate structuredContent | unique | MCP | `tests/mcp-v2-mock.test.ts` |
| O-17 | **One-click "Try it" against echo** — per-protocol downloadable OpenCollection / prefilled route | ergonomic | docs | echo serves `/get /graphql /ws /sse` |
| O-18 | **Generate docs capability summary + ports table from source** | ergonomic | docs | drift in DOCS-5/6 |
| O-19 | **Link/claim validator in docs CI** (`starlight-links-validator`) | ergonomic | docs | nothing gates links today |

## 8. Out-of-scope appendix (noted, not filed)

- Worker WS relay (`/api/ws-ticket`, `/api/ws`) built but never called by the renderer; `websocket-proxy.ts` untested.
- `capabilities.ts`: `grpc.reflection` web:true holds only against the echo shim (see GRPC-2); no `graphql.subscriptions` / MCP-server keys; sub-feature keys missing.
- Electron renderer CSP allows `wss:` while code comments/docs say it's blocked (`vite.config.mts:28`).
- Web unary gRPC reaches only Connect-protocol servers; server-streaming is browser-direct.
- MCP web vs desktop era divergence (covered as MCP-5/6/12).
- gRPC history-dedup comment with no dedup code (`GrpcRequestBuilder.tsx:453`).
- Root `npm ci` fails on npm ≠ 12.1.0 (engines pin).

## 9. Repro tests (uncommitted, in agent worktrees)

| Area | Worktree | Files |
|---|---|---|
| HTTP/GraphQL | `.claude/worktrees/agent-a7d9cdabb3a060acf` | `tests/audit/graphql-gaps.test.ts`, `tests/audit/http-gaps.test.ts` |
| gRPC | `.claude/worktrees/agent-a33a6112b49574d72` | `tests/audit/grpc-{renderer-gaps,connect-gaps,web-reflection,runner-desktop}.test.ts` |
| WS/SIO/SSE | `.claude/worktrees/agent-a88ee7f53b7f6ba4a` | `tests/audit/ws-electron-gaps.test.ts`, `tests/audit/sse-parser-gaps.test.ts` |
| Kafka/MQTT | `.claude/worktrees/agent-a0ab599ec0ff6d14b` | `electron/main/__tests__/audit-kafka-mqtt.test.ts`, `audit-mqtt-handler.test.ts` |
| MCP | `.claude/worktrees/agent-a4cd1034c6df3d5d3` | `tests/audit/mcp-{sdk-gaps,web-client,result-iserror,redirect-ssrf}.test.ts(x)` |
| Cross-cutting | `.claude/worktrees/agent-a41e5e5f0068f1d3e` | `tests/audit/xcut-oc-roundtrip.test.ts`, `xcut-bruno-env-leak.test.ts` |

Some worktrees contain an untracked `node_modules` symlink to the main checkout — delete before committing anything from them. Advisory repros (ADV-2/3/4) must not be committed to a public branch before the fixes land.
