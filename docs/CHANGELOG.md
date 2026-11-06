# Changelog

All notable changes to Restura will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Postman path variables** — HTTP requests keep `:name` path segments with a **Path variables** table under the query params (keys come from the URL; value, description and enabled are editable). Every send path fills them the same way at send time (`shared/protocol/path-variables.ts`: whole segments only, values percent-encoded as one segment, `/ \ ? #` always escaped, host / port / userinfo never touched): the app, collection runner, CLI and code snippets. Postman v2.0 / v2.1 / v3 import keeps `:id` and fills the rows from `url.variable` (no longer baked into the URL); v2.1 / v3 export writes them back and OpenCollection carries them as `type: 'path'` params. Secret-flagged and credential-named rows are counted and redacted on export like headers and query params.
- **Stop button for streamed HTTP responses** — a web SSE / NDJSON / JSON Lines send can be stopped from the streaming panel; Cancel, a new send on the tab, or closing the tab stop it too.

### Fixed

- **Streamed HTTP sends run scripts and write history** — on web, a send with a streaming `Accept` runs the pre-request script before anything is sent (including `pm.execution.skipRequest()`), and when the stream ends runs the test script against the captured stream text (capped at the response size limit) and writes a history entry; a stopped stream records neither. A running stream no longer holds Send for every tab.
- **`pm.execution.skipRequest()` on a single send** — a buffered send from the request page now honours it, like a streamed one: nothing is sent and no history entry is written.
- **Desktop cancels unary gRPC calls** — cancelling a unary call (or a collected server stream) sends `grpc:cancel-request`, so the main-process call is aborted and ends with `CANCELLED` instead of running to its deadline. Calls are scoped to the window that started them.
- **Unhandled promise rejections in scripts** — a rejected promise a script never handles is reported as `Unhandled promise rejection: <reason>` and fails the script, wherever it was dropped (`Promise.reject`, a throwing `.then`, `new Promise`, `pm.sendRequest` / `pm.vault` / `rs.judge` without a handler), in the app and the CLI. An `async` function's promise that is dropped without ever being awaited or chained is still not reported (quickjs-emscripten exposes no host rejection tracker).

### Changed

- **Centralised store persistence on the `createPersistedStore` migration framework** — the version-1 persisted stores (the WebSocket/SSE/Socket.IO/MCP/Kafka/MQTT connection stores plus `console`, `collectionRuns`, `globals`, `graphqlSchemas`, `protoFiles`) now build their zustand `persist` options from a declarative `MigrationDescriptor` via `src/lib/shared/persistence/createPersistedStore.ts` instead of hand-rolling them. This wires every adopted store to the shared migration runner (versioned `steps`, optional Zod `schema`, recoverable quarantine-on-failure, and migration telemetry) and gives them a consistent versioning seam. The factory gained two declarative options to make adoption behaviour-preserving: `legacyLocalStorageKey` (wraps the Dexie adapter with the localStorage one-shot import for graphql/proto) and `onRehydrate` (a post-rehydrate hook for per-record sanitisation, e.g. the console store dropping individual corrupt entries). The multi-version stores (collections, history, settings, request, environment, workflow, cookies) intentionally still hand-roll `persist` — adopting them requires decomposing their monolithic `migrate` into version-keyed steps, which is data-sensitive and done per store.

### Fixed

- **Self-host security** — every Node upstream fetch (HTTP proxy, gRPC, gRPC-Web, reflection, MCP, import, upstream-proxy dial) now dials the address it validated (no DNS-rebind window); JSON request bodies are capped while streaming (chunked bodies included; 64 KiB on the unauthenticated telemetry route); streamed replies drop the upstream `Content-Encoding` / `Content-Length` (the body is already decoded) and `access-control-*` headers; ECS, Alibaba and other metadata endpoints are blocked even with `ALLOW_PRIVATE_IPS`; loopback reached through DNS needs `allowLocalhost` like a literal; the dev auth bypass refuses any non-loopback `Host`.
- **HTTP send path** — the HTTP tab's GraphQL body type sends a `{query, variables}` envelope (and the variables editor saves); desktop returns response bodies byte-for-byte (no JSON re-serialisation: big integers, quoted strings and `null` survive) with the standard `statusText`; a streaming `Accept` (SSE / NDJSON / JSONL) on web renders as a live stream; an auth header replaces a same-name header row in any casing (app, Worker, desktop, CLI); OAuth 1.0a always signs form-urlencoded body fields; a 303 on `HEAD` stays `HEAD`; Ctrl/Cmd+Enter sends from inside the body and script editors; test scripts see the resolved URL and headers, as in the CLI.
- **Scripts** — top-level `await` works; `pm.test(name, function (done) {…})` waits for `done`; `pm.sendRequest` responses have `json()` / `text()` / `headers.get()`, callback errors fail the script, and Postman request objects (`body.mode`, header arrays) are sent correctly; a failed assertion is a failed test, not a script error; `pm.environment.unset` in a pre-request script reaches the request; `pm.variables.get` follows Postman precedence; gRPC, GraphQL and MCP single sends read and save collection variables; the CLI applies pre-request collection writes.
- **Import / export** — a `.http` file's first request (before any `###`) is imported; Bruno export no longer overwrites requests whose names collide; OpenAPI de-duplicates path/operation parameters, maps `Bearer` in any case and cookie API keys, and warns on unmapped schemes; cURL import accepts scheme-less and `{{var}}` URLs and follows shell backslash rules; the Python snippet sends text-only form-data as multipart; generated snippets keep the query string as typed.
- **Realtime and gRPC** — Disconnect during a pending Socket.IO, Kafka or MQTT connect cancels it (no hidden socket, no flip back to connected); desktop SSE accepts `Cookie` / `Origin` headers like web; gRPC-Web replies up to the 10 MB cap work on web and self-host; `google.protobuf.Struct` numbers beyond 2^53 stay numbers (int64 fields keep their digits); web Connect streaming applies the browser target guard; cancelling a unary gRPC call returns at once.
- **Desktop** — menu actions target the window they were used in; a collection folder picked in the dialog is allowed anywhere (system and credential folders still refused); path denylist matching respects separators; plaintext secrets are purged only after the encrypted write succeeds; a failed IndexedDB read can no longer overwrite stored data with defaults.
- **CLI** — JUnit reports failed assertions as `<failure>`; `--output` refuses two reporters writing one file; the stats reporter skips skipped requests; an empty `--data` file is an error; an unterminated trailing SSE event is dropped as in the app.

- **CSRF gate on `/api/*`** — every `POST /api/*` now requires `Content-Type: application/json` (`415` otherwise), checked before auth, so a cross-site page can't drive the proxy with a preflight-free `text/plain` or form POST. In the local-dev auth bypass a request whose `Origin` is neither same-origin nor in `ALLOWED_ORIGIN` is refused with `403` (`worker/app.ts`).
- **Loopback-only local compose** — `docker-compose.local.yml` (which runs `DEV_BYPASS_AUTH=true`) publishes on `127.0.0.1:${RESTURA_LOCAL_PORT:-3000}` only; `docker-compose.yml` documents that it publishes on all interfaces and needs `WORKER_PROXY_TOKEN` or Cloudflare Access.
- **SSRF special-use ranges** — `shared/protocol/url-validation.ts` now treats `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4` (incl. `255.255.255.255`), Teredo `2001::/32`, local-use NAT64 `64:ff9b:1::/48` and IPv6 multicast `ff00::/8` as private, re-checks SIIT/NAT64/Teredo-embedded IPv4, and percent-decodes + NFKC-normalises opaque hosts on non-special schemes (`kafka://%31%32%37.0.0.1`). The self-host DNS guard accepts bracketed IPv6 literals, and the self-host WebSocket relay dials the validated IP (no DNS-rebind window).
- **HTTP query values sent as typed** — query rows are folded into the URL with minimal escaping: `+`, `:`, `,`, `/` and `%XX` go out unchanged and a space becomes `%20`. A pasted `%2B` is no longer stored as `+`. The `/api/proxy` `url` cap rises to 64 KiB.
- **Repeated params and headers kept** — repeated query keys are all sent in order; repeated header rows combine (`, `, or `; ` for `Cookie`) instead of last-wins.
- **RFC 6265 cookie jar** — `Max-Age` (wins over `Expires`; `<= 0` deletes), `Domain` must domain-match and not be a public suffix, host-only cookies, RFC default path, and a user `Cookie` header merges with the jar. Cookies set on each redirect hop are sent on later hops and stored against their own URL on the Worker, self-host and desktop (`finalUrl` / `cookieHops`).
- **GET bodies** — a body written on a `GET` is sent (desktop, CLI) or fails with an explicit `400` on `fetch()`-based hosts (Worker, self-host Node) instead of being stripped silently; an empty GET body sends nothing.
- **OAuth 2.0 token requests via the app transport** — Get Token, device code and auto-refresh go through the Worker `/api/proxy` or desktop HTTP IPC, so the SSRF guard applies, redirects aren't followed, and CORS / the desktop renderer CSP no longer block them. A keychain or external-store client secret/password makes Get Token refuse with a message and skips auto-refresh instead of sending a masked placeholder.
- **Auth fixes** — Basic credentials are UTF-8 encoded everywhere (non-Latin-1 characters threw); the shared and desktop AWS SigV4 signers now agree on path normalisation (S3 excepted) and header-value whitespace, and the desktop signer receives the session token; OAuth 1.0a builds its base string per RFC 5849 §3.4.1 over the exact wire URL.
- **Desktop fails on unavailable secrets** — a keychain handle that can't be resolved (auth, sign-at-wire secrets, mTLS passphrase, HTTP/SOCKS proxy and broker passwords) fails the request with "… is unavailable on this device" instead of sending without credentials. A script that adds a secret variable's value to a header it wasn't saved in is refused.
- **SSE refuses sign-at-wire auth** — SSE connects (app, workflows, CLI) with AWS SigV4, OAuth 1.0a, WSSE, Digest or NTLM are refused instead of streaming anonymously; the CLI treats unnamed events as `message`; `Last-Event-ID` is sent only on reconnects within a session.
- **CLI per-request TLS and proxy** — `restura run` applies an HTTP/GraphQL request's own TLS settings and HTTP(S) proxy on a dedicated connection, and refuses settings it can't apply (SOCKS, keychain/external passphrases) instead of sending differently. The per-request proxy is declared desktop-only for the web client (`http.proxy.perRequest`).
- **`pm.environment` persistence** — `pm.environment.set` / `unset` writes now persist to the active environment on single sends of HTTP, GraphQL, gRPC and MCP requests and to the run's environment during collection runs; desktop secret-handle variables are never overwritten, and a collection's script writing to a shared environment needs a one-time approval per collection. Pre-request writes made before a script error are kept.
- **`pm.request.headers` editable** — `add` / `upsert` / `remove` / `get` / `has` / `all` / `each` / `toObject`; pre-request header edits are sent on web, desktop and the CLI.
- **Script assertions** — `pm.test` awaits a returned promise (a rejection or a never-settling promise fails the test); `pm.response.to.be.*` work as chai-style properties, `to.not` negates, JSON assertions parse a text body, `to.have.status` accepts the status text; the default test template no longer fails on every response; the `pm`→`rs` migration leaves scripts that bind their own `rs` alone.
- **OpenAPI import** — requests use a `{{baseUrl}}` collection variable; relative servers resolve against the URL the spec was fetched from (remote and deep-link imports); multipart binary properties import as file fields without a boundary-less `Content-Type`.
- **cURL import semantics** — `-d` family data is form-urlencoded by default, `--data-binary` is sent verbatim, `--data-urlencode` encodes per curl, `-G` moves data to the query, `--json` sets JSON headers, value-taking options (`-A`, `-e`, `-b`, …) are mapped or consume their value, and query values are kept as typed. `--compressed` is still reported as unsupported.
- **Insomnia and Postman import** — Insomnia `{{ _.var }}` / `{{_['var']}}` references become `{{var}}` and the GraphQL envelope round-trips; Postman v2 folder variables map to folder variables and v2.0 path variables keyed by `id` are substituted.
- **Code generation** — generated Go, Ruby, JS (fetch/axios) and PHP snippets compile/parse (Go `body` redeclaration and unused imports, Ruby JSON bodies and `#{}`, JS string escaping, PHP `$` interpolation); curl sends empty header values as `Key;`; snippets include the default `Content-Type` the app sends.
- **gRPC** — reflection request templates are sendable (map fields as objects, one oneof member, `Any` as `{}`, 64-bit integers as `"0"`); int64 values typed as JSON numbers keep their exact digits; the web builder sends Connect requests with a saved reflection snapshot when reflection is unreachable.
- **GraphQL variables** — `{{vars}}` are substituted inside JSON string values (a `"` or `\` no longer empties the variables); invalid or non-object variables JSON fails the run/CLI item explicitly; the CLI merges `@defer` / `@stream` incremental responses.
- **Socket.IO / MQTT stuck states** — a refused Socket.IO handshake or exhausted reconnects end disconnected instead of stuck on Connecting/Reconnecting, and the URL query survives non-default namespaces and Query-tab params; an MQTT CONNACK refusal ends the connection instead of "reconnecting" forever. Desktop WebSocket sends report main's refusals and refuse text frames over 1 MB.
- **MCP control server redaction** — `get_history` filters match the redacted URL only (no secret oracle via filter + limit), `get_request` masks secret-named and token-shaped rows, and the `send_request` approval card shows inherited auth. MCP schema `minLength` / `maxLength` count code points.
- **AI** — an unpriced model reports unknown cost, never `$0` (the cost scorer fails); truncated provider streams are reported as errors; Gemini `thoughtSignature` is kept through tool loops; Anthropic model discovery follows pagination; the assistant's local providers get the same LAN carve-out as AI Lab.
- **Backup export/import and storage stats now cover every table** — `db.exportAllData()`, `db.importAllData()`, and `db.getStorageStats()` in `src/lib/shared/database.ts` hand-listed their tables and had drifted: only `clearAllData()` was kept current. Every table added after schema v5 (`console`, `graphqlSchemas`, `protoFiles`, `aiChat`, `globals`, `aiLab`, `evalRuns`, `arenaRuns`, `collectionRuns`) was silently omitted, so "Export all data" produced incomplete backups and the storage monitor under-counted records. All four methods now derive their table set from Dexie's live `this.tables` (excluding the internal `metadata` KV table), so future `version(N).stores(...)` additions are covered automatically. Backup format version bumped 5 → 6; import stays backward-compatible with older backups (records merge per table by key). This also closes the data-loss path the GraphQL/proto Dexie move opened.
- **GraphQL schema cache & proto registry now persist to encrypted Dexie** (see [ADR-0014](./adr/0014-zustand-persistence.md)) — `useGraphQLSchemaStore` and `useProtoRegistryStore` shipped without a `storage` adapter, so zustand persisted them to plaintext `window.localStorage`, contrary to ADR-0014 ("the legacy localStorage adapter has been removed"). On desktop their endpoint URLs and proto file bodies sat unencrypted at rest. Both now use the encrypted Dexie pipeline (the `graphqlSchemas` / `protoFiles` tables added in DB v7 that were never wired up). A new storage-layer helper, `src/lib/shared/legacyLocalStorageFallback.ts`, one-shot-imports any data previously written to localStorage — writing it into Dexie before deleting the plaintext copy — so the migration loses nothing. The `StoreName` source-of-truth union in `src/lib/shared/persistence/types.ts` was realigned with the `dexieStorageAdapters` registry (it was missing `mqttConnections`, `aiChat`, `aiLab`, `evalRuns`, `arenaRuns`, `collectionRuns`, `globals`).

### Added

- **GraphQL over HTTP: GET, `Accept`, `@defer` / `@stream`** (#885) — GraphQL requests now send `Accept: application/graphql-response+json, application/json;q=0.9` unless the user sets one. A URL-bar method chip switches between POST and GET; GET URL-encodes `query` / `variables` / `operationName` / `extensions` and is refused for mutations and subscriptions. The method persists on the request and round-trips through OpenCollection as `graphql.method`. `multipart/mixed` incremental responses (deferSpec=20220824 and the newer `pending`/`completed` format) are parsed by `shared/protocol/multipart-mixed-parser.ts` and merged by `shared/protocol/graphql-incremental.ts` into one result before test scripts and history see it. On the web each part renders as it arrives, through the Worker streaming pass-through, which now stamps `x-restura-proxy-stream` so the renderer can tell upstream replies from proxy errors. Streamed replies now also withhold headers the browser would act on against the Restura origin (`STREAM_FORWARD_DENY` in `shared/protocol/header-policy.ts`, e.g. `Location`, `WWW-Authenticate`, `Clear-Site-Data`, HSTS, `Alt-Svc`). They mask 3xx/401/407 to 200 and carry the real status and the withheld headers in `x-restura-upstream-*` side channels. The renderer transport fetches with `redirect: 'manual'` and restores the real status and headers before SSE, HTTP streaming or GraphQL consumers see them. Desktop shows the merged result once the response completes, because Electron HTTP IPC buffers.
- **Electron renderer-cleanup and pre-flight DNS guard** (see [ADR-0006](./adr/0006-electron-connection-and-dns-hardening.md))
  - `electron/main/connection-cleanup.ts` — idempotent `destroyed` listener dedupe (`bindRendererCleanup`) and walk-and-dispose helper (`disposeByOwner`) shared by every long-lived streaming handler (gRPC, MCP, SSE, WebSocket, Socket.IO)
  - `electron/main/dns-guard.ts` — `assertHostnameSafe` / `assertUrlHostnameSafe` close the SSRF gap for transports without a connector-level `lookup` hook by running `assertResolvedAddressAllowed` against every record from `dns.lookup`. Pre-flight only — true DNS-rebind (TTL=0 swap during connect) is intentionally out of scope and tracked for follow-up
- **App icons** — Multi-resolution app icons added at `electron/resources/icons/` (16/32/48/64/128/256/512/1024 PNG) and `icon.icns` / `icon.png`. `package.json` `build` step now generates icons.
- **Pre-filled echo URLs for new request tabs** — New HTTP, gRPC, GraphQL, and WebSocket tabs open with `https://echo.restura.dev/...` already in the URL field instead of a placeholder hint. Existing persisted tabs are unaffected; this only applies to newly created tabs/connections.
- **OpenCollection v1.0.0 native support** — Restura now reads and writes the same YAML format as Bruno 3.1+ (see [docs/opencollection.md](./opencollection.md))
  - `src/lib/opencollection/` module: vendored JSON Schema, generated TS types, hand-written Zod runtime validators, YAML serializer, filesystem reader/writer (bundled and directory layouts), bidirectional bridges to Restura's internal Collection model
  - Importer: new "OpenCollection" tab in the Import dialog accepts bundled YAML files; SSE/MCP requests are surfaced via the spec's `extensions` field (`x-restura-sse`, `x-restura-mcp`); unrecognized HTTP body shapes are reported via `getAndResetUnrecognizedBodyCount()` and a `console.warn` so the user can detect data not surfaced in the editor (the original is preserved via `_oc` for export round-trip)
  - Exporter: new "OpenCollection (YAML)" entry in the collection export menu emits a bundled YAML document; the `_oc` passthrough bag keeps unmodified items byte-stable. When some items are edited but the collection root still has `_oc`, root metadata (config, docs, non-restura extensions, info extras) is preserved while only the items array and Restura-managed extensions are rebuilt
  - Vendored fixture set (simple HTTP, multi-protocol, directory layout) at `tests/fixtures/opencollection/`
  - 23 new unit/integration tests covering schemas, serializer, fs-reader, fs-writer, roundtrip, importer, exporter, and the to/from-internal bridges
  - Web-mode Playwright smoke test for the import drop-zone happy path and error path (`e2e/opencollection-import.spec.ts`)
- **Request Chaining & Workflows** — Execute requests sequentially with data passing between them
  - Create and manage workflows within collections
  - Add steps from existing requests in your collection
  - Variable extraction from responses using:
    - JSONPath (dot notation): `data.user.id`, `items[0].name`
    - Regex with capture groups: `"token":"([^"]+)"`
    - Response headers: `X-Request-Id`, `Authorization`
  - Precondition scripts for conditional step execution
  - Retry policies with configurable attempts, delay, and exponential backoff
  - Real-time execution progress and logging
  - Execution history tracking
  - Visual workflow builder with step management
  - Live extraction testing/preview
  - New "Workflows" tab in sidebar
  - Full TypeScript support with Zod validation
  - Comprehensive test coverage (43 tests)

### Changed

- `electron/main/file-operations.ts` migrated to async `fs` (no behavioral change; main process no longer blocks on disk IO)
- `electron/main/store-handler.ts` encryption key fetched from OS keychain via `safeStorage`; explicit startup warning if `safeStorage.isEncryptionAvailable() === false` so users know plaintext fallback is active
- `electron/main/main.ts` now logs uncaught exceptions for diagnosability

### Security

- Removed `com.apple.security.network.server` entitlement from `electron/resources/entitlements.mac.plist` — the desktop app is a client only
- All streaming handlers (`grpc-handler.ts`, `mcp-handler.ts`, `sse-handler.ts`, `websocket-handler.ts`, `socketio-handler.ts`) refactored to use `assertUrlHostnameSafe` before connect

### Removed

- Legacy single-bucket `ipc-rate-limiter` API surface. Every IPC handler now uses the per-handler keyed limiters (`createKeyedRateLimiter` in `electron/main/ipc/ipc-rate-limiter.ts`).

### Technical Details

- New store: `useWorkflowStore` with localStorage persistence
- New hook: `useWorkflowExecution` for React components
- New components: `WorkflowManager`, `WorkflowBuilder`, `WorkflowExecutor`, `WorkflowStep`, `VariableExtractorConfig`
- New library functions: `executeWorkflow`, `extractVariables`, `testExtraction`
- Types: `Workflow`, `WorkflowRequest`, `VariableExtraction`, `WorkflowExecution`, `WorkflowExecutionStep`
- New module: `src/lib/shared/echo-defaults.ts` — single source of truth for the hosted echo URLs (`ECHO_URLS`)

## [0.1.0] - 2025-11-17

### Added

- Initial release of Restura
- HTTP/REST request builder with all methods (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD)
- gRPC client with reflection support
- Environment variables with `{{variable}}` syntax
- Collections for organizing requests
- Request history with favorites
- Pre-request and test scripts (QuickJS sandbox)
- Code generation (cURL, JavaScript, Python, Go, etc.)
- Import/Export support:
  - Postman collections
  - Insomnia collections
  - OpenAPI/Swagger specifications
- Authentication methods:
  - Basic Auth
  - Bearer Token
  - API Key
  - OAuth2
  - Digest Auth
  - AWS Signature
- Proxy configuration
- Cookie management
- Response viewer with syntax highlighting
- Dark/Light theme support
- Desktop app (Electron) for macOS, Windows, Linux
- Web client (Vite + React SPA on Cloudflare Pages)

---

## Version History Format

Each version entry includes:

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Vulnerability fixes
