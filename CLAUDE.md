# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Restura is a multi-protocol API client supporting **HTTP/REST, GraphQL, gRPC, WebSocket, Socket.IO, SSE, Kafka, MQTT, and MCP** (Model Context Protocol), plus an **AI assistant** that can read request context. It ships from a single React renderer to three targets: a web app (Cloudflare Pages + Workers), a self-hostable Node/Docker server, and an Electron desktop app. Restura can also act _as_ an MCP server (`src/features/mcp-server`, `electron/main/handlers/mcp-server-handler.ts`). Node.js 24+ required.

See also: `SECURITY.md` (vulnerability reporting), `CONTRIBUTING.md` (contribution guidelines), `SECURITY_AUDIT.md` (2026-06-21 audit report with findings and fixes).

## Development Commands

```bash
# Web development (Vite + Cloudflare Worker via Miniflare)
npm run dev                    # Start Vite dev server (port 5173) — boots the Worker locally too
npm run build                  # Production build (SPA + Worker bundle)
npm run preview                # Preview production build
npm run type-check             # TypeScript strict mode (renderer tsconfig only)
npm run type-check:all         # Type-check ALL tsconfigs (renderer + worker + electron + cli) — matches CI
npm run lint                   # ESLint over src/ electron/main worker/ echo/ echo-local/ cli/ scripts/
npm run lint:fix               # ESLint --fix
npm run format                 # Prettier write
npm run format:check           # Prettier check

# Worker / Node API (shared Hono app — Cloudflare + self-host)
npx tsc --noEmit -p worker/tsconfig.json    # Type-check Worker independently

# Testing
npm run test                   # Vitest interactive
npm run test:run               # Vitest single run
npm run test:watch             # Vitest watch
npm run test:coverage          # Coverage report
npm run test:e2e               # Playwright (boots dev server via webServer; needs .dev.vars)
npm run test:e2e:ui            # Playwright UI mode
npm run test:e2e:headed        # Playwright headed
npm run test:e2e:electron:build && npm run test:e2e:electron   # Desktop e2e: _electron launch of the unpacked prod build (e2e-electron/), per-protocol smoke vs local mocks + native gRPC dev server. Kafka/MQTT specs auto-bring-up the Dockerised Redpanda+EMQX brokers (echo-local/docker-compose.yml) via the `brokers` fixture and skip if Docker is absent
npm run test:contract          # Contract tests (vitest run tests/contract)
npm run grpc:server            # Native gRPC dev server on :50051 — desktop gRPC e2e needs real h2; the echo Worker's Connect endpoint is web-only
vitest run path/to/file.test.ts                  # Run a single Vitest file
vitest run -t "test name pattern"                # Filter by test name
npx playwright test e2e/real-http.spec.ts        # Run a single e2e spec

# Full validation (matches CI)
npm run validate               # type-check:all + lint + verify:opencollection-types + capabilities:check + test:run

# Generated code
npm run proto:gen                       # buf generate (regenerates protobuf TS)
npm run gen:opencollection-types        # Regenerate OpenCollection JSON Schema → TS
npm run verify:opencollection-types     # Generate + fail if diff (CI gate)
npm run capabilities:matrix             # Regenerate docs/CAPABILITY_MATRIX.md from src/lib/shared/capabilities.ts
npm run capabilities:check              # Fail if the matrix is stale (CI gate)

# Self-hosted Node / Docker server (single process: SPA + /api/* on one port)
npm run build:web:docker       # Plain SPA build for Docker (no Cloudflare plugin)
npm run build:server           # esbuild Worker → dist/server/index.mjs (Node entry)
npm run build:docker           # build:web:docker + build:server (full Docker build)
npm run start                  # node dist/server/index.mjs (PORT/HOST/RESTURA_STATIC_ROOT env-tunable)
# Dockerfile + docker-compose.yml at repo root; see docs/SELF_HOSTING.md

# Electron desktop app
npm run electron:dev           # Dev mode (Vite + Electron with wait-on)
npm run electron:compile       # Compile main process TS → dist/electron/
npm run electron:build:web     # Build renderer for Electron (VITE_IS_ELECTRON_BUILD=true)
npm run electron:dist:{mac,win,linux}    # Package distributables
npm run electron:pack          # Unpacked dir build (for local smoke testing)

# Local echo stack (desktop testing only)
npm run echo:local             # Boot full-protocol local upstream (HTTP, gRPC, WS, SSE, MQT…)
npm run echo:local:certs       # Generate local CA + client cert for mTLS testing
npm run echo:local:collection  # Export importable OpenCollection fixture

# Deploy
npm run deploy                 # Production: Worker (api.restura.dev) + Pages
npm run deploy:preview         # Preview version + Pages preview
npm run deploy:echo            # Deploy the echo test server (echo/wrangler.jsonc)
npm run deploy:docs            # Deploy docs site (docs-site/)

# Docs site
npm run docs:dev               # Local docs site dev server
npm run docs:build             # Build docs site
npm run docs:check             # Lint/check docs site

# Misc
npm run sentry:sourcemaps      # Upload sourcemaps to Sentry after production build
npm run version:bump           # Bump version (package.json + electron-builder)
```

## Architecture

### Multi-Platform: One Renderer, Three Backends

The same Vite-built React SPA serves all targets. The transport layer is the only thing that differs — chosen at runtime by `isElectron()` in `src/lib/shared/platform.ts`. The two HTTP backends (Cloudflare Worker and Node/Docker server) share a single Hono app via the `createApp(deps)` factory in `worker/app.ts`; each entry supplies its own adapters for the platform-specific bits (CONNECT proxy, native WebSocket).

- **Web** — SPA on Cloudflare Pages → fetch `/api/*` → Cloudflare Worker (Hono) at `worker/index.ts` → upstream. Same-origin, no CORS friction.
- **Self-hosted** — `worker/node-entry.ts` runs `createApp` in one Node process that serves both the SPA (`dist/web`) and `/api/*` on one port. Node-native adapters live in `worker/shared/tcp-proxy-node.ts`, `worker/shared/dns-guard-node.ts`, `worker/handlers/websocket-node.ts`. `nodeEntry` MUST `Object.assign` onto `c.env` (not reassign) — `@hono/node-ws` stamps state onto that exact reference. See `docs/SELF_HOSTING.md`.
- **Desktop** — SPA loaded via `file://` → IPC over `window.electron` (preload bridge; `contextBridge.exposeInMainWorld('electron', …)`) → Electron main process handlers in `electron/main/handlers/` → upstream. The Worker is **never** bundled into the desktop app (`electron-builder.json` files glob excludes `_worker.js`).
- **Routing** — `createHashRouter` so the renderer works under both `https://` (Pages) and `file://` (Electron). There is no server-side routing.
- **Build flags** — `VITE_IS_ELECTRON_BUILD=true` activates the Electron renderer bundle; `VITE_IS_DOCKER_BUILD=true` activates the plain SPA bundle (no Cloudflare plugin) for the Node/Docker entry.

### Shared protocol core (`shared/protocol/`) — read this first

This is the most important architectural piece in the repo. Each protocol (HTTP, gRPC, MCP, SSE, WebSocket, AI) is implemented **once** as a backend-agnostic orchestrator. Each backend (Cloudflare Worker, Node/Docker server, Electron main process) supplies only a thin `Fetcher` adapter; everything else — SSRF validation, header sanitisation, body construction, response shape, gRPC status mapping, SSE/NDJSON parsing — lives in `shared/protocol/` and runs identically across all of them.

```
                    shared/protocol/{http,grpc,mcp,websocket}-proxy.ts
                    (validation, body, headers, response shape)
                                       │
                                Fetcher interface
                          ┌────────────┴────────────┐
                          ▼                         ▼
              worker/handlers/*.ts        electron/main/handlers/*-handler.ts
              (globalThis.fetch)          (Node http/https/net)
```

Key modules:

- `shared/protocol/url-validation.ts` — SSRF guard: RFC 1918, RFC 6598 (CGNAT), link-local 169.254/16, loopback, cloud-metadata endpoints, IPv6 unique-local, IPv4-mapped IPv6. Single source of truth (before this refactor, the guard had drifted between backends).
- `shared/protocol/header-policy.ts` — Hop-by-hop deny lists, header sanitisers.
- `shared/protocol/credential-header-names.ts` — Shared denylist of credential-bearing header names; used by both `ai/redaction.ts` and `electron/main/security/collection-export-redactor.ts` so the list stays in one place.
- `shared/protocol/body-builder.ts` — JSON / text / form-urlencoded / form-data / binary.
- `shared/protocol/types.ts` — `RequestSpec`, `Fetcher`, `ExecuteResult` discriminated union.
- `shared/protocol/http-proxy.ts`, `grpc-proxy.ts`, `mcp-proxy.ts`, `websocket-proxy.ts`, `sse-parser.ts`, `ndjson-parser.ts`.
- `shared/protocol/sse-stream-reader.ts` — Low-level SSE byte-stream reader (used by `sse-parser.ts`).
- `shared/protocol/redirect-follower.ts` — Centralised manual redirect handling shared by HTTP and SSE proxies.
- `shared/protocol/rate-limiter.ts` — Token-bucket rate limiter used in the shared proxy layer.
- `shared/protocol/ai/` — AI chat orchestrator (`ai-proxy.ts`) + per-provider wire shapes (`provider-routes.ts`) and decoders (`providers/{openai,anthropic,openrouter}.ts`, each paired with a fixture). The orchestrator is provider-agnostic and emits raw SSE bytes downstream; `redaction.ts` scrubs secrets from prompts/context. See AI assistant note below.
- `shared/protocol/auth-signer.ts`, `oauth1-signer.ts`, `wsse-header.ts` — auth signing **at the wire** (Worker/Electron, not the renderer) so signatures match exact upstream bytes.
- `shared/protocol/secret-value-schema.ts`, `crypto-utils.ts` — `SecretRef` handle-based secrets (ADR-0007); see State + Persistence below.

**When adding a new protocol**: add `shared/protocol/<name>-proxy.ts` exposing `execute<Name>Proxy(spec, fetcher, options)`, then ~30 lines of Fetcher adapter each in `worker/handlers/` and `electron/main/handlers/`. SSRF, headers, body, timeouts come for free.

### AI assistant (`src/features/ai/`)

A chat assistant that can read the current request/response context. **Electron-first**: the renderer streams via the IPC bridge (`window.electron.ai` → `ai:chat` / `ai:chat:cancel`, with `ai:chat:chunk:<id>` / `ai:chat:end:<id>` event channels) → `electron/main/handlers/ai-handler.ts` → `shared/protocol/ai/ai-proxy.ts`. There is **no `/api/ai` Worker route**, so the web path is not wired through the proxy — confirm platform support before assuming parity. Renderer pieces: `lib/promptBuilder.ts`, `lib/contextSnapshot.ts` (captures request context; URLs/secrets redacted), `lib/streamConsumer.ts` (subscribe to chunk channel **before** invoking `chat`). Providers (OpenAI, Anthropic, OpenRouter) decode in `shared/protocol/ai/providers/*` against fixtures. See `docs/adr/0010-ai-assistant-architecture.md`.

### AI Lab (`src/features/ai-lab/`) — Electron-only LLM/eval workbench

A separate workbench for testing prompts and models: per-provider config, a multi-model Playground, datasets, an eval runner with LLM-as-judge + scorers, and OpenAPI-driven test generation. Renderer state persists to Dexie tables `aiLab`/`evalRuns`; provider API keys are stored only as `SecretRef` handles (`apiKeyHandleId`, resolved in main). Backed by `electron/main/handlers/ai-lab-handler.ts` — a sibling to `ai-handler.ts` kept separate so the chat path is untouched. It adds a non-streaming `complete` (used heavily by the eval runner/judge, bounded by a queueing semaphore), model discovery + connection test, and a **localhost SSRF carve-out**: the same shared URL guard runs, but `allowLocalhost` is derived from provider kind — true only for local runtimes (Ollama, OpenAI-compatible), never for cloud providers. `src/lib/shared/judgeBridge.ts` bridges the eval runner's judge calls to the IPC layer. See `docs/adr/0020-ai-lab-eval-workbench.md`.

### Feature-based renderer layout (`src/features/`)

Each feature module owns its components, hooks, lib (executors/clients), and store. Protocol features (`http/`, `grpc/`, `graphql/`, `websocket/`, `socketio/`, `sse/`, `mcp/`, `kafka/`, `mqtt/`) follow the same shape and export a `protocol.ts` describing their schema. The renderer's executor in each feature branches on `isElectron()` to pick IPC vs. HTTP transport — no behavioural difference.

```
src/features/{http,grpc,graphql,websocket,socketio,sse,mcp,kafka,mqtt}   # protocol features
src/features/ai                                      # AI assistant (chat + request-context tooling)
src/features/ai-lab                                  # Electron-only LLM/prompt testing & eval workbench
src/features/mcp-server                              # Restura-as-MCP-server (agent-drivable surface)
src/features/load-testing                            # collection load/perf runner (not a protocol)
src/features/{collections,environments,workflows,scripts,auth,registry,contracts}
src/components/{ui,shared,providers}
src/routes/                                          # React Router route components
src/lib/shared/                                      # platform, encryption, storage, validators, capabilities, etc.
src/lib/shared/persistence/                          # Abstraction layer: createPersistedStore, runMigrations, quarantine, telemetry
src/lib/shared/codeGenerators/                       # Code generation for 8 target languages
src/lib/opencollection/                              # OpenCollection spec import/export (generated types)
```

> **Capability parity is data-driven.** `src/lib/shared/capabilities.ts` is the single source of truth for which features work on web vs. desktop (e.g. Kafka and SOCKS/PAC/mTLS are desktop-only — no browser TCP). It is codegen'd into `docs/CAPABILITY_MATRIX.md` and gated by `npm run capabilities:check`. Update `capabilities.ts` (not the doc) when you add a feature that differs across platforms.

### State + Persistence (Zustand)

All global state lives in Zustand stores with the `persist` middleware. Stores are validated with Zod schemas in `src/lib/shared/store-validators.ts`.

- **Web** — `src/lib/shared/dexie-storage.ts` (IndexedDB via Dexie).
- **Desktop** — `src/lib/shared/secure-storage.ts` (encrypted electron-store via IPC; key wrapped by Electron `safeStorage` → OS keychain).
- **The legacy localStorage adapter has been removed.** Don't add new persistence through `window.localStorage`.
- `src/lib/shared/debouncedStorage.ts` — debounced write wrapper (prevents write storms on rapid state changes).
- `src/lib/shared/migrate-legacy-storage.ts` — one-time migration helpers for stores that changed shape.
- `src/lib/shared/persistence/` — cross-platform abstraction (`createPersistedStore`, `runMigrations`, `quarantine` for corrupt-store recovery, `telemetry` for migration events).

Stores: `useRequestStore` (tabs[] + activeTabId — multi-tab model), `useCollectionStore`, `useEnvironmentStore`, `useHistoryStore`, `useSettingsStore`, `useWorkflowStore`, `useKafkaStore`, `useCollectionRunStore` (persisted run history, Dexie `collectionRuns`), AI store (`src/features/ai/store.ts`).

**Secret handling — `SecretRef` (ADR-0007).** Secret-bearing auth fields are migrating from plaintext `string` to `SecretValue = string | SecretRef`, where `SecretRef` is `{ kind: 'inline'; value }` or `{ kind: 'handle'; id; label? }`. With a `handle`, the renderer **never sees the plaintext** — `electron/main/security/secret-handle-store.ts` (electron-store + `safeStorage`) holds the encrypted value and resolves it only at wire-signing time in the main process. This keeps secrets out of the Zustand store, Dexie/electron-store persistence, exported collections, crash logs, and the MCP-server's agent-readable surface. Migration is incremental (per-descriptor); see `docs/adr/0007-secret-ref-pattern.md` and `electron/main/security/collection-export-redactor.ts`. `src/lib/shared/secretRef-migrations.ts` provides migration helpers for moving stores from plaintext to `SecretRef`.

**Key-value secret redaction** — `src/lib/shared/keyvalue-secret-redaction.ts` scrubs credential-bearing headers/query-params from exported collections and history snapshots, using the shared denylist in `shared/protocol/credential-header-names.ts`.

### Electron main process (`electron/main/`)

The main process is organised into subdirectories by concern. `main.ts` is the entry/orchestrator. `window-manager.ts` loads `http://localhost:5173` in dev, `dist/web/index.html` in prod.

**`electron/main/handlers/`** — one file per protocol/feature (23 files):
- `http-handler.ts`, `grpc-handler.ts`, `grpc-reflection-handler.ts`, `websocket-handler.ts`, `socketio-handler.ts`, `sse-handler.ts`, `mcp-handler.ts`, `kafka-handler.ts`, `mqtt-handler.ts`, `ai-handler.ts`, `ai-lab-handler.ts`, `mcp-server-handler.ts` (+ `mcp-context-loader.ts`), `mock-server-handler.ts`, `vault-handler.ts`, `git-handler.ts`
- `channel-event-bridge.ts` — maps IPC channel names to handler callbacks
- `fetch-fetcher.ts` — `globalThis.fetch`-backed Fetcher adapter (used by handlers that don't need native TCP)
- `grpc-connect.ts`, `grpc-credentials.ts`, `grpc-serde.ts` — gRPC/ConnectRPC transport helpers (see ADR-0022)
- `sse-parser.ts` — SSE stream parser (shared with `shared/protocol/sse-parser.ts` via re-export)

**`electron/main/ipc/`** — IPC boundary management:
- `ipc-validators.ts` + `ipc-rate-limiter.ts` — input validation and rate limits at the IPC boundary (legacy rate-limiter API deprecated; see ADR-0006)
- `connection-cleanup.ts` — idempotent renderer-`destroyed` listener dedupe (`bindRendererCleanup`) + walk-and-dispose helper (`disposeByOwner`). Shared by every long-lived streaming handler.
- `ipc-utils.ts` — shared IPC helpers
- `rate-limiter-cleanup.ts` — cleans up per-window rate-limiter state on renderer destroy

**`electron/main/storage/`** — persistence bridge:
- `store-handler.ts`, `collection-manager.ts` — persistent storage bridge (encryption key fetched from OS keychain via `safeStorage`; warns at startup if unavailable)
- `vault-handler.ts` — credential vault IPC handler
- `file-operations.ts` — async fs helpers

**`electron/main/security/`** — security and auth utilities (11 files):
- `dns-guard.ts` — pre-flight SSRF guard. `assertHostnameSafe` / `assertUrlHostnameSafe` resolve the hostname and call `assertResolvedAddressAllowed` from `shared/protocol/url-validation` against every record. Pre-flight only — does NOT mitigate true DNS-rebind (TTL=0 swap during connect).
- `safe-connect.ts` — SSRF-guarded `net`/`tls` connect helper shared by streaming handlers
- `auth-applier.ts` — applies resolved auth/secrets to outbound requests
- `secret-handle-store.ts`, `encrypted-key.ts`, `keychain-status-handler.ts` — `SecretRef` handle store + key management (see ADR-0007)
- `collection-export-redactor.ts` — strips secrets from exported collections
- `kafka-broker-guard.ts`, `mqtt-broker-guard.ts` — broker-level SSRF guards for Kafka/MQTT
- `aws-sigv4-smithy.ts` — AWS SigV4 signing via Smithy (used by `auth-applier.ts`)
- `env-proxy.ts` — reads system proxy settings for use by handlers

**`electron/main/lifecycle/`** — app lifecycle (9 files):
- `auto-updater.ts`, `deep-link-handler.ts`, `menu.ts`, `system-tray.ts`, `window-controls.ts`, `notifications.ts`
- `sentry.ts` + `telemetry-consent.ts` — opt-out error reporting (on by default, disabled in Settings)
- `request-logger.ts`, `logging.ts`

**`electron/main/util/`** — `debounce.ts`

**`electron/shared/channels.ts`** — IPC channel name constants (type-checked against `electron/types/electron-api.ts` in the preload via `satisfies ElectronAPI`).

**`preload.ts`** — context-isolated IPC bridge (`window.electron`); bundled by esbuild (`electron:bundle-preload`) so the sandboxed preload is self-contained.

Electron-only capabilities (PAC resolution, SOCKS4/5, mTLS, custom CA, pre-flight DNS guard via `security/dns-guard.ts`, manual redirect handling) live inside the Electron fetcher closure — **not** in `shared/protocol/`. Keep `shared/` backend-agnostic. See `docs/adr/0006-electron-connection-and-dns-hardening.md` for the cleanup/DNS-guard design and `docs/adr/0021-maintenance-harness.md` for the overall harness architecture.

### Worker (`worker/`)

Hono app (`createApp` in `worker/app.ts`, composed with Cloudflare adapters in `worker/index.ts`) deployed as Cloudflare Pages Functions. Routes: `/health`, `/ready`, `/api/proxy`, `/api/grpc`, `/api/grpc/reflection`, `/api/mcp`, `/api/telemetry/error`, `/api/feature-flags`, `/api/ws-ticket`, `/api/ws`. The same `createApp` is reused by the Node/Docker entry (`worker/node-entry.ts`). Notable bits:

- The web build (`@cloudflare/vite-plugin`, active only when **not** an Electron/Docker build) emits the SPA to `dist/web/client/` and the Worker bundle + `wrangler.json` to `dist/web/restura/` — the two `npm run deploy` targets.
- `nodejs_compat` flag enabled (for `Buffer` etc.) — see `wrangler.jsonc`.
- Worker-only feature: upstream-proxy via the Cloudflare Sockets API in `worker/shared/tcp-proxy.ts`.
- Rate limiting in `worker/middleware/rateLimiter.ts`.
- Request ID injection in `worker/middleware/requestId.ts` — stamps every request with a `X-Request-ID` header for tracing.
- `worker/shared/dns-guard-node.ts` — Node-native DNS guard (mirrors `electron/main/security/dns-guard.ts` for the self-hosted entry).
- `worker/shared/validate-body.ts` — request body validation middleware.
- **Auth gate**: production requires `WORKER_PROXY_TOKEN` or `REQUIRE_CF_ACCESS=true` (secrets). Local dev bypasses auth only when (a) Miniflare is running (auto-detected via `globalThis.MINIFLARE`), or (b) `DEV_BYPASS_AUTH=true` in `.dev.vars`. **Never** put `DEV_BYPASS_AUTH` in `wrangler.jsonc` (the deployed config).
- `ENVIRONMENT` var gates `allowLocalhost` in URL validation. Set to `development` in `.dev.vars` to proxy localhost during local iteration. e2e tests rely on `.dev.vars` existing **before** the dev server boots — `playwright.config.ts` bootstraps this synchronously at config-load time.

### Echo test server (`echo/`)

A separate Cloudflare Worker (`echo/wrangler.jsonc`) used by e2e tests as a controlled upstream. Handlers for HTTP, GraphQL, SSE, WebSocket, and Connect/gRPC. Deploy with `npm run deploy:echo`. Not part of the production app.

### Local echo stack (`echo-local/`)

A developer-facing, full-protocol local upstream for manually testing the **desktop** client — what `echo/` (web-only) can't host: native gRPC, real Kafka/MQTT brokers, mTLS, and a local CA. `npm run echo:local` boots the in-process protocols on stable ports (see `echo-local/ports.ts`), reusing the `e2e/mocks/*` factories + `scripts/grpc-dev-server.mjs` in place; it generates a manifest, a local CA + client cert (for `customCa`/mTLS), and an importable OpenCollection. Kafka (Redpanda) and MQTT (EMQX — the client defaults to MQTT 5, which the pure-JS Aedes can't serve) run via `docker compose -f echo-local/docker-compose.yml up` (Redpanda config in `echo-local/redpanda/`). Not part of the production app. See `echo-local/README.md`.

### CLI subproject (`cli/`)

Standalone npm package `@restura/cli` (separate `package.json`, built with `tsup`). Runs collections in CI with JUnit/HTML/JSON reporters. Self-contained — has its own deps and tests.

Internal structure:
- `cli/src/commands/run.ts` — collection runner CLI entrypoint
- `cli/src/reporters/` — 7 reporter types: `html`, `json`, `junit`, `live`, `stats`, `composite`, `types`
- `cli/src/runner/executors/` — 8 protocol executors: `auth`, `dispatch`, `grpc`, `http`, `mcp`, `sse`, `websocket`, `types`
- `cli/src/runner/` — loader/resolver pipeline: `collectionLoader`, `dataLoader`, `envLoader`, `filter`, `retry`, `runner`, `scriptRunner`, `undiciFetcher`, `varResolver`
- `cli/fixtures/` — test fixtures

### Docs site (`docs-site/`)

Standalone Astro + MDX documentation site (`@restura/docs-site`, deployed to docs.restura.dev) with its own `package.json`. Scripts from repo root: `npm run docs:dev`, `docs:build`, `docs:check`, `deploy:docs`. Not part of the production app build.

## Key Technical Patterns

- **Path alias** `@/` → `./src/` (configured in `tsconfig.json` and `vitest.config.ts`).
- **Build tool**: Vite 8 + `@vitejs/plugin-react` + `@cloudflare/vite-plugin`. The Cloudflare plugin boots Miniflare during `vite dev` so one command runs both SPA and Worker. Config is `vite.config.mts` (must be ESM — the Cloudflare plugin is ESM-only).
- **Tailwind v4** via `@tailwindcss/vite` (no separate PostCSS config).
- **Lazy components**: `src/lib/shared/lazyComponent.tsx` wraps `React.lazy` + `Suspense` (mirrors `next/dynamic` ergonomics — `next/dynamic` was removed).
- **Strict TS**: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`. `exactOptionalPropertyTypes` is **off** intentionally.
- **UI** — Radix UI primitives + Tailwind, shadcn/ui patterns in `src/components/ui/`.
- **Script sandbox** — pre-request and test scripts run in QuickJS WASM (`src/features/scripts/lib/scriptExecutor.ts`). No DOM, no filesystem, no network escape; memory + execution-time capped.
- **Collection import/export** — Postman v2.1, Insomnia, and OpenCollection (`src/lib/opencollection/`, with codegen — `spec-types.ts` is generated, validated by `verify:opencollection-types`).
- **Code generation** — `src/lib/shared/codeGenerators/` emits request snippets for 8 target languages. `mcp.ts` and `websocket.ts` are the most recently updated generators.
- **Certificate matching** — `src/lib/shared/certMatcher.ts` matches client cert descriptors to request URLs (used by mTLS path).
- **Multiple tsconfigs** — `tsconfig.json` (renderer), `electron/tsconfig.json` (main), `worker/tsconfig.json` (Worker), `echo/tsconfig.json` (echo), `cli/tsconfig.json` (CLI), plus `src/features/http/tsconfig.json`. `tsconfig.base.json` holds shared compiler options. **`npm run type-check` only covers the renderer** — the root `tsconfig.json` excludes `worker`, `electron/main`, and `cli`, so a green `type-check` does _not_ mean those projects compile. Use **`npm run type-check:all`** (chained into `npm run validate`) to type-check every project the way CI does. `npm run lint` does cover all of them.

## Testing

- **Unit/integration**: Vitest in jsdom, colocated `*.test.ts(x)` files. Setup in `tests/setup.ts`. React Testing Library for components.
- **e2e**: Playwright in `e2e/`. Tests prefixed `real-*` hit live upstreams (or the local echo server); `playwright.config.ts` boots the dev server via its `webServer` config. `workers: 1` and `fullyParallel: false` are deliberate — multiple suites share dev server state. `e2e/global-setup.ts` and `bootstrapPrereqs()` ensure `.dev.vars` exists before Miniflare reads it (load-bearing).
- **Security tests**: `tests/security/` for SSRF, header policy, redirect handling regressions, and security-hardening coverage:
  - `ai-lab-localhost-policy.test.ts` — AI-Lab SSRF localhost carve-out validation
  - `ai-redaction.test.ts` — AI context redaction (URLs, secrets)
  - `http-executor-no-fallback.test.ts` — HTTP executor route validation
  - `response-viewer-sandbox.test.ts` — response viewer sandboxing
  - `secret-storage-routing.test.ts` — secret storage backend routing
  - `socketio-dns-pinning.test.ts` — Socket.IO DNS pinning
  - `sse-proxy-routing.test.ts` — SSE proxy routing
  - `visualizer-sandbox.tsx` — visualizer component sandboxing
- **Cross-platform secret parity**: `tests/secret-ref-parity.test.ts` — verifies `SecretRef` round-trips identically on both web and desktop paths.
- **Electron e2e**: `e2e-electron/` — launched via `_electron` (not a browser); per-protocol smoke tests vs local mocks + native gRPC dev server.
- **Contract tests**: `tests/contract/` — schema compatibility tests run with `npm run test:contract`.

## Electron Build

`electron-builder.json` defines the build. Process:

1. `electron:build:web` — `vite build` with `VITE_IS_ELECTRON_BUILD=true` → `dist/web/`
2. `electron:compile` — Compiles `electron/main/` TypeScript → `dist/electron/`
3. `electron-builder` — Packages from `dist/` per target (`electron:dist:{mac,win,linux}`)

The renderer entry is `dist/web/index.html` loaded via `file://` with hash routing. `_worker.js` is excluded from the Electron bundle.

## ADRs (Architecture Decision Records)

Located in `docs/adr/`. Key records:
- `0006` — Electron connection + DNS hardening
- `0007` — SecretRef pattern (handle-based secrets)
- `0010` — AI assistant architecture
- `0020` — AI Lab eval workbench
- `0021` — Maintenance harness
- `0022` — gRPC/ConnectRPC transport

## CI / GitHub

- `.github/workflows/ci.yml` — main CI gate (runs `npm run validate`)
- `.github/workflows/security-audit.yml` — security audit CI gate
- `.github/workflows/release.yml` — release workflow
- `.github/workflows/dependency-review.yml` — dependency review on PRs
- `.github/dependabot.yml` — automated dependency updates
- `.github/CODEOWNERS` — code ownership map

## Agent / Skill Infrastructure

- `.claude/skills/` — Claude Code skills (`restura-feature-dev`, `restura-production-checks`, `ship-check`, `docs-sync`, `new-protocol`)
- `.agents/skills/` — parallel skill definitions for other agent runtimes (`restura-feature-dev`, `agent-browser`, `electron-pro`)
- `AGENTS.md` — parallel project guide for Codex and other AI agents (less detailed than this file)
