# Changelog

All notable changes to Restura will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Centralised store persistence on the `createPersistedStore` migration framework** — the version-1 persisted stores (the WebSocket/SSE/Socket.IO/MCP/Kafka/MQTT connection stores plus `console`, `collectionRuns`, `globals`, `graphqlSchemas`, `protoFiles`) now build their zustand `persist` options from a declarative `MigrationDescriptor` via `src/lib/shared/persistence/createPersistedStore.ts` instead of hand-rolling them. This wires every adopted store to the shared migration runner (versioned `steps`, optional Zod `schema`, recoverable quarantine-on-failure, and migration telemetry) and gives them a consistent versioning seam. The factory gained two declarative options to make adoption behaviour-preserving: `legacyLocalStorageKey` (wraps the Dexie adapter with the localStorage one-shot import for graphql/proto) and `onRehydrate` (a post-rehydrate hook for per-record sanitisation, e.g. the console store dropping individual corrupt entries). The multi-version stores (collections, history, settings, request, environment, workflow, cookies) intentionally still hand-roll `persist` — adopting them requires decomposing their monolithic `migrate` into version-keyed steps, which is data-sensitive and done per store.

### Fixed

- **Backup export/import and storage stats now cover every table** — `db.exportAllData()`, `db.importAllData()`, and `db.getStorageStats()` in `src/lib/shared/database.ts` hand-listed their tables and had drifted: only `clearAllData()` was kept current. Every table added after schema v5 (`console`, `graphqlSchemas`, `protoFiles`, `aiChat`, `globals`, `aiLab`, `evalRuns`, `arenaRuns`, `collectionRuns`) was silently omitted, so "Export all data" produced incomplete backups and the storage monitor under-counted records. All four methods now derive their table set from Dexie's live `this.tables` (excluding the internal `metadata` KV table), so future `version(N).stores(...)` additions are covered automatically. Backup format version bumped 5 → 6; import stays backward-compatible with older backups (records merge per table by key). This also closes the data-loss path the GraphQL/proto Dexie move opened.
- **GraphQL schema cache & proto registry now persist to encrypted Dexie** (see [ADR-0014](./adr/0014-zustand-persistence.md)) — `useGraphQLSchemaStore` and `useProtoRegistryStore` shipped without a `storage` adapter, so zustand persisted them to plaintext `window.localStorage`, contrary to ADR-0014 ("the legacy localStorage adapter has been removed"). On desktop their endpoint URLs and proto file bodies sat unencrypted at rest. Both now use the encrypted Dexie pipeline (the `graphqlSchemas` / `protoFiles` tables added in DB v7 that were never wired up). A new storage-layer helper, `src/lib/shared/legacyLocalStorageFallback.ts`, one-shot-imports any data previously written to localStorage — writing it into Dexie before deleting the plaintext copy — so the migration loses nothing. The `StoreName` source-of-truth union in `src/lib/shared/persistence/types.ts` was realigned with the `dexieStorageAdapters` registry (it was missing `mqttConnections`, `aiChat`, `aiLab`, `evalRuns`, `arenaRuns`, `collectionRuns`, `globals`).

### Added

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

### Deprecated

- Legacy `ipc-rate-limiter` API surface in `electron/main/ipc-rate-limiter.ts`. Per-handler rate limits remain; the legacy facade will be removed in a future minor.

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
