# Changelog

All notable changes to Restura will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **OpenCollection v1.0.0 native support** — Restura now reads and writes the same YAML format as Bruno 3.1+ (see [docs/opencollection.md](./opencollection.md))
  - `src/lib/opencollection/` module: vendored JSON Schema, generated TS types, hand-written Zod runtime validators, YAML serializer, filesystem reader/writer (bundled and directory layouts), bidirectional bridges to Restura's internal Collection model
  - Importer: new "OpenCollection" tab in the Import dialog accepts bundled YAML files; SSE/MCP requests are surfaced via the spec's `extensions` field (`x-restura-sse`, `x-restura-mcp`)
  - Exporter: new "OpenCollection (YAML)" entry in the collection export menu emits a bundled YAML document; the `_oc` passthrough bag keeps the output byte-stable when the collection has not been edited
  - Vendored fixture set (simple HTTP, multi-protocol, directory layout) at `tests/fixtures/opencollection/`
  - 23 new unit/integration tests covering schemas, serializer, fs-reader, fs-writer, roundtrip, importer, exporter, and the to/from-internal bridges
  - Web-mode Playwright smoke test for the import drop-zone happy path and error path (`e2e/opencollection-import.spec.ts`)

### Changed

- `electron/main/collection-manager.ts` no longer redeclares the legacy file-collection Zod schema; imports the canonical schema from `src/lib/shared/file-collection-schema.ts` instead.
- File watcher in Electron debounces IPC events with a 250ms window, coalescing repeat `(directory, type, path)` events that bulk-save operations otherwise produce.

### Deprecated

- `src/lib/shared/file-collection-schema.ts` (the legacy `.http.yaml`/`.grpc.yaml`/`.sse.yaml`/`.mcp.yaml` per-request format). New code should target `@/lib/opencollection`. The legacy module remains load-bearing for the CLI runner and the existing Electron file watcher; full removal is tracked in the Phase 1/3 roadmap.

### Workflows (existing, prior entry)

- **Request Chaining & Workflows** - Execute requests sequentially with data passing between them
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

### Technical Details

- New store: `useWorkflowStore` with localStorage persistence
- New hook: `useWorkflowExecution` for React components
- New components: `WorkflowManager`, `WorkflowBuilder`, `WorkflowExecutor`, `WorkflowStep`, `VariableExtractorConfig`
- New library functions: `executeWorkflow`, `extractVariables`, `testExtraction`
- Types: `Workflow`, `WorkflowRequest`, `VariableExtraction`, `WorkflowExecution`, `WorkflowExecutionStep`

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
