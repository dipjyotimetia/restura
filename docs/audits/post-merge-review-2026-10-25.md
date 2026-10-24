# Post-merge review — 2026-10-25

Scope: the 72 PRs merged to `main` between `fa5b6d13` (2026-10-10) and `406b2b6d`
(984 files, +115.8k / −10k). Goal: find bugs introduced by accident: regressions,
defects in new features, problems where PRs meet, and security regressions.
Docs drift is out of scope. A web/desktop parity gap counts only where one
harness is actually broken.

Method: 6 cluster reviews (gRPC, GraphQL+HTTP, Kafka+presets, MCP,
WebSocket/streaming, deps+cross-PR seams) plus a security-boundary audit, all
static and read-only. Then the full gate, web e2e and desktop e2e, run against
lockfile-correct dependencies. Every **Confirmed** item below was re-traced in
code by the reviewer before inclusion; items marked † were confirmed by the
cluster trace and spot-checked rather than re-traced line by line.

Security-sensitive findings are listed by title and status only. Details are in
a separate private note for advisory drafting.

## Gate results (main @ 406b2b6d, deps reinstalled from lockfile)

| Gate | Result |
|---|---|
| type-check:all, lint, test:tooling, verify:opencollection-types, capabilities:check, architecture:check | ✅ |
| test:ci (coverage), test:electron:critical-coverage, test:workspaces | ✅ |
| build, size, build:docker, build:workspaces, electron:build:web, electron:compile | ✅ |
| Web Playwright e2e | ✅ 205 passed, 2 skipped |
| Desktop `_electron` e2e (Docker brokers up) | ❌ 63 passed, 2 failed: `mcp-stdio.spec.ts:29` (deterministic, finding 1), `grpc.spec.ts:46` (known flake, passes on rerun) |
| Unit flake | `worker/handlers/__tests__/grpc-web.test.ts` "chunked body … 413" fails about 40% of runs (finding 23) |

**Process gap:** the desktop e2e, web e2e and pack-smoke jobs are *skipped* on
`main` CI. #1126 passed desktop e2e on its own PR, but #1133 and #1134 then broke it
on `main` and nothing caught it.

## Confirmed — introduced in this window

| # | Sev | Finding | Where | PR |
|---|---|---|---|---|
| 1 | **High** | **MCP Launch settings / Headers panel collapses to 2px at the default 1400×900 window.** #1133 (Import) and #1134 (Conformance) each added a `shrink-0` button to the row holding the `flex-1 min-w-0` toggle. The stdio args/env editor and the HTTP Headers editor can't be opened, and Conformance overflows the pane. Breaks desktop e2e `mcp-stdio.spec.ts`. | `src/features/mcp/components/McpConnectionPanel.tsx:225-260` | #1133 + #1134 on #1126 |
| 2 | **High** | **Collection runner MCP requests send literal `{{var}}` auth.** `withAuthHeaders` resolves vars into a header. `createAndInitClient` then rebuilds auth from raw `mcp.auth` with an identity resolver, and `mergeHeaders` lets that override win. Any templated Bearer/Basic/API-key gets a 401 in the runner; `restura run` is correct. | `src/features/mcp/protocol.ts:123-129`, `lib/mcpAuth.ts:156`, `lib/mcpRunRequest.ts:141` | #1131 |
| 3 | Med | **CLI GraphQL GET items send no query.** OC import now yields `method: 'GET'`. The CLI builds a JSON body, then `executeHttpProxy` drops the body for GET, and nothing moves it into `query=` params. | `cli/src/runner/executors/http.ts:175`, `shared/protocol/http-proxy.ts:142` | #1109 |
| 4 | Med | **CLI gRPC ignores `wireProtocol` and the #900 auth block.** grpc-web-pinned requests are sent as Connect. SigV4/OAuth1/WSSE/Digest/NTLM requests go out **unauthenticated** instead of failing with FAILED_PRECONDITION. | `cli/src/runner/executors/grpc.ts` | #1094/#1088 (CLI not wired) |
| 5 | Med | **Web gRPC server streams with "No deadline" abort immediately.** `timeoutMs: 0` passes through `??` into connect-es, whose `createDeadlineSignal(0)` fires at once with DEADLINE_EXCEEDED. Desktop and grpc-web handle 0 correctly. | `src/features/grpc/lib/grpcStreamingClient.ts:221,275` | #1089 |
| 6 | Med | **Kafka preset silently drops Schema Registry Bearer auth.** The preset type has no `authType`, so `resolveRegistry` falls back to Basic and sends no header. Handle-backed tokens aren't stored at all. Result: 401 / schema-less decode with no warning. | `src/features/kafka/lib/kafkaPreset.ts:82-88,217`, `shared/types/broker.ts:49` | #1130 on #1127 |
| 7 | Med | **Desktop WS auto-reconnect never gives up when the server accepts and then closes** (auth/policy close codes). `handleOpen` resets attempts to 0 every cycle, so `maxReconnectAttempts` is never reached. | `src/features/websocket/lib/websocketManager.ts:432,464` | #1112 |
| 8 | Med† | **MCP runner exhausts the shared 60/min `mcpRateLimiter`.** A rate-limit error is treated as fatal: the pooled session is evicted, and reconnecting burns more budget, so failures cascade for runs of 60+ items per minute. | `electron/main/handlers/mcp-handler.ts` (limiter), `src/features/mcp/lib/mcpRunRequest.ts` | #1131 |
| 9 | Med-low | **Kafka browse mode has no backpressure and no abort.** The emit chain grows without bound and keeps decoding after Unsubscribe. The `AbortController` is never aborted, and there is no decode timeout. | `electron/main/handlers/kafka-handler.ts:258-264` | #1121 |
| 10 | Med-low† | Stdio MCP requests in the collection runner fail with the misleading "A command is required" (stdio opts are not passed). | `src/features/mcp/protocol.ts:~131` | #1131 after #1126 |
| 11 | Low-med† | Stdio sessions never get the client-request bridge, so they advertise no roots/elicitation/sampling. The Roots panel is still shown for stdio. | `electron/main/handlers/mcp-handler.ts` (`connectStdio`), `mcp-sdk-client.ts:~108` | #1122 × #1126 |
| 12 | Low-med† | Stderr listener leaks when a stdio server exits, and stderr lines are duplicated on each reconnect. | `src/features/mcp/components/McpRequestBuilder.tsx:~112-127` | #1126 |
| 13 | Low-med† | A renderer reload (Cmd+R) leaves stdio children running in main (cleanup only runs on webContents `destroyed`). Up to 8 slots leak, after which you get "Too many running stdio MCP servers". | `electron/main/ipc/connection-cleanup.ts` | #1126 |
| 14 | Low-med† | The Conformance probe silently drops keychain/OAuth auth and probes anonymously, so the report shows 401-driven failures. | `McpRequestBuilder.tsx:~203`, `mcp-conformance-handler.ts` | #1134 |
| 15 | Low | `stopMcpCleanup`: `stopMcpClientRequests()` is unreachable after `return terminateAllStdioChildren()`. This is a lost hunk from the stack merge. The electron tsconfig doesn't set `allowUnreachableCode: false`, so it compiled. | `electron/main/handlers/mcp-handler.ts:664-665` | #1126 over #1122 |
| 16 | Low | gRPC collection runner turns a saved "No deadline" stream into a 30s deadline; interactive Send gives no deadline. | `src/features/grpc/lib/grpcSchemaSnapshot.ts:37`, `protocol.ts:285` | #1063 × #1089 |
| 17 | Low | CLI gRPC with saved `timeout: 0` aborts immediately (`setTimeout(abort, 0)`). | `cli/src/runner/executors/grpc.ts:86`, `shared/protocol/grpc-proxy.ts:127` | #1089 |
| 18 | Low† | Kafka unsubscribe/disconnect commits before in-flight emits finish, so delivered records are re-delivered on resubscribe (at-least-once, no loss). | `kafka-handler.ts` `closeConsumerAndStream` | #1125 |
| 19 | Low | electron-store 12 (conf 16): with `clearInvalidConfig: true`, reading a corrupt or undecryptable store now **rewrites the file on read**, leaving no chance to back it up. Affects store-handler, vault, secret-handle-store, external-secret-profile-store, mcp-stdio-consent. | `electron/main/storage/store-handler.ts:48` and siblings | #1141 |
| 20 | Low† | electron-store 12: vault keys like `a[x` now throw from dot-prop (`VAULT_KEY_RE` allows them). | `electron/main/storage/vault-handler.ts:61` | #1141 |
| 21 | Low† | WS `connectArgs` (resolved URL and auth headers) are retained after a server-initiated terminal close. | `websocketManager.ts` `handleClose` | #1112 |
| 22 | Low | Strict hex parsing now rejects `0x48` and single-nibble bytes that were accepted before. The error is clear, but it is a behaviour change. | `websocketManager.ts:~550` | #1111 |
| 23 | Test | `grpc-web.test.ts` 413 flake is a **test race**: the server does send the 413, but the client's next write hits the closed socket (EPIPE). Real-world impact is minor (a self-host chunked-upload client over the cap may see a reset instead of a 413). | `worker/handlers/__tests__/grpc-web.test.ts` | #1096 |

## Security (titles only — see private note)

| # | Sev | Finding | Status |
|---|---|---|---|
| S1 | Med | MCP config import returns HTTP-header secrets to the renderer in plaintext. Only stdio env rows become handles. | **New**, #1133 |
| S2 | Low | A new IPC event handler is missing `rateLimited`. | **New**, #1113 |
| S3 | Med-High (self-host) | Two Worker routes follow upstream redirects without per-hop validation. | Known, **still open** |
| S4 | Med | A desktop streaming transport follows redirects outside the DNS pin. | Pre-existing, **still open** |
| S5 | Low-Med | A desktop handshake follows redirects to IP-literal targets. | Pre-existing, **still open** |
| S6 | Med (needs renderer compromise) | Gap in the file-write denylist; it matters more now that #1126 stdio consent exists. | Pre-existing, **still open** |

## Previously known (2026-10-12 review)

| Item | Status |
|---|---|
| HTTP `{{vars}}` not resolved in auth fields (`requestExecutor.ts:279`) | **Still open, and wider**: GraphQL subscriptions now resolve vars (#1108) but queries on the same tab don't. Digest (#1077) hashes the literal `{{pw}}`. `resolveAuthVariables` covers only bearer/basic/api-key/oauth2. |
| H6 — redacted export leaks `_oc` header/param/metadata rows | **Fixed** in #1124 (`shared/secrets/collection-redaction.ts:150-222`). Residual: `{name,value}` lists under other keys (`query`, `vars`, `connectionParams`, form `fields`). |
| Worker gRPC redirect-follow | Still open (S3) |
| `/api/mcp` POST redirect-follow | Still open (S3) |
| #898 socket bypass | Still open; a desktop variant was also found (S4) |

## Suspect (unverified — worth a look)

- WS hex sends with `{{secret}}`: the transcript is masked, but `binaryData` keeps the resolved bytes (#1114).
- Unified timeline sanitises up to 5000 events per flush even when the panel is closed. Possible CPU stalls under high-rate streams (#1115).
- GraphQL: switching the operation from a subscription to a query leaves the tab bar with no active tab and an empty panel (#1107).
- Web streaming Set-Cookie side-channel header has no size cap and could exceed header limits with many cookies (#1072).
- @platformatic/kafka 2.14 enables SNI by default, which may change behaviour for alias/IP-pinned brokers (#1081).
- Broker preset credentials are bound to the preset id, not the broker address (#1130).
- gRPC-Web relay still caps the whole stream at 10 MB, while desktop moved to per-message caps. Is this deliberate on the Worker? (#1094)

## Test-gap / housekeeping

- **Coverage budget:** branches uncovered = **5190**, below the pre-#1149 cap of 5226. The temporary raise to 5300 can be reverted now (lines 3518/4378, functions 1197/1344, statements 4544/5321).
- **Local toolchain:** `validate` requires npm 12.1.0. npm 12 skips dependency install scripts by default, so after `npm ci` the Electron binary is missing (it had to be fetched with `node node_modules/electron/install.js`), and esbuild/workerd/keytar/protobufjs need `npm rebuild`. Worth documenting or allow-listing.
- `format:check` scans gitignored `.playwright-mcp/` artifacts and fails locally.
- Cleanup duplicates left from merges: `KAFKA_SECRET_SCOPE` is defined twice (`handlers/kafka/registry.ts:37`, `sasl.ts:38`), and `partitionKey` is defined twice.
- Desktop e2e `grpc.spec.ts:46` is still flaky.

## Checked and clean (highlights)

IPC channel/handler/preload/validator parity (programmatic); IPC_MODULES
register/dispose; Dexie versions; Zod schema changes all widen, so old persisted
data still loads; framer-motion 14 / Radix / React / Vite bumps; electron-store 12
load path and file format; zstd/stacked decoding bounds; Digest retry body
rebuild and origin pinning; extension-method allowlists across every consumer;
Set-Cookie preservation; gRPC transport caps and per-message bounds on desktop;
#1129 IPv6 broker guard intact; Kafka OAuth/MSK IAM/GSSAPI secret handling; MCP
stdio consent, env allowlist and config-import consent path; MCP OAuth fetch
guards and token storage; WS base64 codec, close codes and deflate default;
timeline memory bounds.

## Fix status

| Findings | PR |
|---|---|
| 1 (MCP panel layout) | #1150 |
| 2, 8 (runner side), 10 | #1151 |
| 5, 16, 17 | #1152 |
| 6 | #1153 |
| 9, 18, duplicate constants | #1154 |
| CLI fails to start (found while fixing; affects published 1.10.0–1.13.0) | #1155 |
| Suspect: GraphQL stale tab | #1156 |
| Suspect: timeline flush cost (941ms → 13.5ms) | #1157 |
| Suspect: Set-Cookie side-channel size | #1158 |
| Suspect: preset credentials bound to id | #1159 |
| 8 (main side), 11, 12, 13, 14, 15 | #1160 |
| 3, 4 | #1161 |
| 7, 21, 22, S2 | #1162 |
| Known: HTTP `{{vars}}` in auth (+ desktop secret vars, CLI) | #1163 |
| 19, 20 | #1164 |
| S1 | #1165 |
| 23, coverage ratchet, biome, npm 12 install scripts | #1166 |
| Process gap: e2e skipped on `main` | #1167 |
| S3–S6 | private advisory forks |
| Suspect: Kafka SNI (2.14) | Not reproduced — brokers aren't IP-pinned; servername stays the hostname |
| Suspect: WS `binaryData` secret | Not reproduced — only byte lengths are consumed |

Also in this pass: CodeQL alert #277 (`mcp-oauth-store.ts:60`,
insufficient-password-hash) was triaged as a false positive. It hashes public
identifiers into a lookup id. A comment now explains this, and the alert is
dismissed.
