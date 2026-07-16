# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

## Project Overview

Restura is a multi-protocol API client supporting **HTTP/REST, GraphQL, gRPC, WebSocket, Socket.IO, SSE, Kafka, MQTT, and MCP** (Model Context Protocol), plus an **AI assistant** that can read request context. It ships from a single React renderer to three targets: a web app (Cloudflare Pages + Workers), a self-hostable Node/Docker server, and an Electron desktop app. Restura can also act _as_ an MCP server (`src/features/mcp-server`, `electron/main/handlers/mcp-server-handler.ts`). Node.js 24+ required.

## Development Commands

```bash
# Web development (Vite + Cloudflare Worker via Miniflare)
npm run dev                    # Start Vite dev server (port 5173) — boots the Worker locally too
npm run build                  # Production build (SPA + Worker bundle)
npm run preview                # Preview production build
npm run type-check             # TypeScript strict mode — renderer only (excludes worker, electron/main, cli)
npm run type-check:all         # Full type-check across all tsconfigs — what CI runs
npm run lint                   # Biome lint over src/ shared/ electron/main/ worker/ echo/ echo-local/ cli/ tests/ scripts/
npm run lint:fix               # Biome lint --write
npm run format                 # Biome format (write)
npm run format:check           # Biome format check

# Worker / Node API (shared Hono app — Cloudflare + self-host)
npx tsc --noEmit -p worker/tsconfig.json    # Type-check Worker independently

# Testing
npm run test                   # Vitest interactive
npm run test:run               # Vitest single run
npm run test:watch             # Vitest watch
npm run test:ui                # Vitest browser UI dashboard
npm run test:coverage          # Coverage report
npm run test:e2e               # Playwright (boots dev server via webServer; needs .dev.vars)
npm run test:e2e:ui            # Playwright UI mode
npm run test:e2e:headed        # Playwright headed
npm run test:e2e:electron:build && npm run test:e2e:electron   # Desktop e2e: _electron launch of the unpacked prod build (e2e-electron/), per-protocol smoke vs local mocks + native gRPC dev server. Kafka/MQTT specs auto-bring-up the Dockerised Redpanda+EMQX brokers (echo-local/docker-compose.yml) via the `brokers` fixture and skip if Docker is absent
npm run test:contract          # Contract tests (vitest run tests/contract)
npm run grpc:server            # Native gRPC dev server on :50051 — desktop gRPC e2e needs real h2; the echo Worker's Connect endpoint is web-only
npm run echo:local             # Full-protocol local upstream for desktop testing (HTTP, gRPC, WebSocket, SSE, mTLS, local CA); Kafka/MQTT need Docker

vitest run path/to/file.test.ts                  # Run a single Vitest file
vitest run -t "test name pattern"                # Filter by test name
npx playwright test e2e/real-http.spec.ts        # Run a single e2e spec

# Coverage-aware local shipping validation — not the entire matrixed CI pipeline
npm run validate               # type-check:all + lint + format:check + codegen/capability checks + test:ci (coverage) + cli test

# Generated code
npm run proto:gen                       # buf generate (regenerates protobuf TS)
npm run gen:opencollection-types        # Regenerate OpenCollection JSON Schema → TS
npm run verify:opencollection-types     # Generate + fail if diff (CI gate)
npm run capabilities:matrix             # Regenerate docs/CAPABILITY_MATRIX.md from src/lib/shared/capabilities.ts
npm run capabilities:check              # Fail if the matrix is stale (CI gate)

# Self-hosted Node / Docker server (single process: SPA + /api/* on one port)
npm run build:docker           # build:web:docker (plain SPA → dist/web) + build:server (esbuild Worker → dist/server/index.mjs)
npm run start                  # node dist/server/index.mjs (PORT/HOST/RESTURA_STATIC_ROOT env-tunable)
# Dockerfile + docker-compose.yml at repo root; see docs/SELF_HOSTING.md

# Electron desktop app
npm run electron:dev           # Dev mode (Vite + Electron with wait-on)
npm run electron:compile       # Compile main process TS → dist/electron/
npm run electron:build:web     # Build renderer for Electron (VITE_IS_ELECTRON_BUILD=true)
npm run electron:dist:{mac,win,linux}    # Package distributables
npm run electron:pack          # Unpacked dir build (for local smoke testing)

# Deploy
npm run deploy                 # Production: Worker (api.restura.dev) + Pages
npm run deploy:preview         # Preview version + Pages preview
npm run deploy:echo            # Deploy the echo test server (echo/wrangler.jsonc)
```

## Architecture

### Multi-Platform: One Renderer, Three Backends

The same Vite-built React SPA serves all targets. The transport layer is the only thing that differs — chosen at runtime by `isElectron()` in `src/lib/shared/platform.ts`. The two HTTP backends (Cloudflare Worker and Node/Docker server) share a single Hono app via the `createApp(deps)` factory in `worker/app.ts`; each entry supplies its own adapters for the platform-specific bits (CONNECT proxy, native WebSocket).

- **Web** — SPA on Cloudflare Pages → fetch `/api/*` → Cloudflare Worker (Hono) at `worker/index.ts` → upstream. Same-origin, no CORS friction.
- **Self-hosted** — `worker/node-entry.ts` runs `createApp` in one Node process that serves both the SPA (`dist/web`) and `/api/*` on one port. Node-native adapters live in `worker/shared/tcp-proxy-node.ts`, `worker/shared/dns-guard-node.ts`, `worker/handlers/websocket-node.ts`. `nodeEntry` MUST `Object.assign` onto `c.env` (not reassign) — `@hono/node-ws` stamps state onto that exact reference. See `docs/SELF_HOSTING.md`.
- **Desktop** — SPA loaded via `file://` → IPC over `window.electron` (preload bridge; `contextBridge.exposeInMainWorld('electron', …)`) → Electron main process handlers in `electron/main/*-handler.ts` → upstream. The Worker is **never** bundled into the desktop app (`electron-builder.json` files glob excludes `_worker.js`).
- **Routing** — `createHashRouter` so the renderer works under both `https://` (Pages) and `file://` (Electron). There is no server-side routing.

### Shared protocol core (`shared/protocol/`) — read this first

This is the most important architectural piece in the repo. Each protocol (HTTP, gRPC, MCP, SSE, WebSocket, AI) is implemented **once** as a backend-agnostic orchestrator. Each backend (Cloudflare Worker, Node/Docker server, Electron main process) supplies only a thin `Fetcher` adapter; everything else — SSRF validation, header sanitisation, body construction, response shape, gRPC status mapping, SSE/NDJSON parsing — lives in `shared/protocol/` and runs identically across all of them.

```
                    shared/protocol/{http,grpc,mcp,websocket}-proxy.ts
                    (validation, body, headers, response shape)
                                       │
                                Fetcher interface
                          ┌────────────┴────────────┐
                          ▼                         ▼
              worker/handlers/*.ts        electron/main/*-handler.ts
              (globalThis.fetch)          (Node http/https/net)
```

Key modules:

- `shared/protocol/url-validation.ts` — SSRF guard: RFC 1918, RFC 6598 (CGNAT), link-local 169.254/16, loopback, cloud-metadata endpoints, IPv6 unique-local, IPv4-mapped IPv6. Single source of truth (before this refactor, the guard had drifted between backends).
- `shared/protocol/header-policy.ts` — Hop-by-hop deny lists, header sanitisers.
- `shared/protocol/body-builder.ts` — JSON / text / form-urlencoded / form-data / binary.
- `shared/protocol/types.ts` — `RequestSpec`, `Fetcher`, `ExecuteResult` discriminated union.
- `shared/protocol/http-proxy.ts`, `grpc-proxy.ts`, `mcp-proxy.ts`, `websocket-proxy.ts`, `sse-parser.ts`, `ndjson-parser.ts`.
- `shared/protocol/ai/` — AI chat orchestrator (`ai-proxy.ts`) + per-provider wire shapes (`provider-routes.ts`) and decoders (`providers/{openai,anthropic,openrouter}.ts`, each paired with a fixture). The orchestrator is provider-agnostic and emits raw SSE bytes downstream; `redaction.ts` scrubs secrets from prompts/context. See AI assistant note below.
- `shared/protocol/auth-signer.ts`, `oauth1-signer.ts`, `wsse-header.ts` — auth signing **at the wire** (Worker/Electron, not the renderer) so signatures match exact upstream bytes.
- `shared/protocol/secret-value-schema.ts`, `crypto-utils.ts` — `SecretRef` handle-based secrets (ADR-0007); see State + Persistence below.

**When adding a new protocol**: add `shared/protocol/<name>-proxy.ts` exposing `execute<Name>Proxy(spec, fetcher, options)`, then ~30 lines of Fetcher adapter each in `worker/handlers/` and `electron/main/`. SSRF, headers, body, timeouts come for free.

### AI assistant (`src/features/ai/`)

A chat assistant that can read the current request/response context. **Electron-first**: the renderer streams via the IPC bridge (`window.electron.ai` → `ai:chat` / `ai:chat:cancel`, with `ai:chat:chunk:<id>` / `ai:chat:end:<id>` event channels) → `electron/main/handlers/ai-handler.ts` → `shared/protocol/ai/ai-proxy.ts`. There is **no `/api/ai` Worker route**, so the web path is not wired through the proxy — confirm platform support before assuming parity. Renderer pieces: `lib/promptBuilder.ts`, `lib/contextSnapshot.ts` (captures request context; URLs/secrets redacted), `lib/streamConsumer.ts` (subscribe to chunk channel **before** invoking `chat`). Providers (OpenAI, Anthropic, OpenRouter) decode in `shared/protocol/ai/providers/*` against fixtures. See `docs/adr/0010-ai-assistant-architecture.md`.

### AI Lab (`src/features/ai-lab/`) — Electron-only LLM/eval workbench

A separate workbench for testing prompts and models: per-provider config, a multi-model Playground, datasets, an eval runner with LLM-as-judge + scorers, OpenAPI-driven test generation, and an **Arena** (round-robin pairwise model-vs-model judging → Elo leaderboard + win-rate matrix, `Arena.tsx`/`lib/elo.ts`/`lib/arenaRunner.ts`/`store/useArenaStore.ts`). Renderer state persists to Dexie tables `aiLab`/`evalRuns`/`arenaRuns` (the last added in `database.ts` version 13); provider API keys are stored only as `SecretRef` handles (`apiKeyHandleId`, resolved in main). Backed by `electron/main/handlers/ai-lab-handler.ts` — a sibling to `ai-handler.ts` kept separate so the chat path is untouched. It adds a non-streaming `complete` (used heavily by the eval runner/judge, bounded by a queueing semaphore), model discovery + connection test, and a **localhost SSRF carve-out**: the same shared URL guard runs, but `allowLocalhost` is derived from provider kind — true only for local runtimes (Ollama, OpenAI-compatible), never for cloud providers.

Scorers include deterministic checks, `script` (QuickJS), `judge` (multi-criteria weighted LLM-as-judge with self-consistency + anchors + gates in `shared/protocol/ai/judge.ts`), `tool-call` (function-call correctness), and `pairwise` (preference judging via `runPairwiseJudge`, with position-bias swap). Datasets can be hand-written, OpenAPI-generated, adversarial/red-team-generated, imported from request **history/collections** (`lib/datasetFromHistory.ts` + `ImportFromHistoryDialog`, secrets redacted via `shared/protocol/ai/redaction.ts`), or CSV/JSONL imported/exported; cases support multi-turn conversations. An **`http-exec` eval target** (ADR 0023) parses an HTTP/GraphQL request out of the model output (`lib/requestExtractor.ts`), executes it through the **real request executor** (`src/features/http/lib/requestExecutor.ts` via `lib/execCell.ts` — SSRF guard/redirects/cookies inherited, no parallel path), and scores the upstream response instead of the model prose. Reports add CSV/JSON/Markdown export, per-case drill-down, and cross-model diff.

The **Agents** tab uses the backend-agnostic `shared/agent-lab/` core: versioned suites, conservative per-model capabilities with explicit user-asserted overrides, bounded tool loops and run-wide token budgets, task-aware graders/judge quorum, typed traces, repeated-trial statistics, MCP/sandbox extension contracts, and opt-in OTLP/OpenInference export. Eval and agent surfaces each own a module-scoped cancellable lifecycle across tab changes; they reject same-surface concurrent starts but may run alongside each other, and cancellation reaches model/judge/tool work and wins over late success. Desktop adapters live in `lib/agentRuntime.ts`/`agentTools.ts`; saved HTTP request tools reuse `executeRequest`, and non-read calls require approval. Desktop persistence/export must use sanitized bounded agent report envelopes; opaque sensitive output may still require access controls. `restura agent eval` consumes the same suite/runner for headless CI, but currently supports only stateless OpenAI Responses (`store: false`, no server continuation), environment credentials, and no judges, tools, secret handles, or base-URL overrides. Keep the capability matrix honest: an adapter contract is not shipped support until its desktop/CLI resolver is wired end to end.

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
src/lib/opencollection/                              # OpenCollection spec import/export (generated types)
```

> **Capability parity is data-driven.** `src/lib/shared/capabilities.ts` is the single source of truth for which features work on web vs. desktop (e.g. Kafka and SOCKS/PAC/mTLS are desktop-only — no browser TCP). It is codegen'd into `docs/CAPABILITY_MATRIX.md` and gated by `npm run capabilities:check`. Update `capabilities.ts` (not the doc) when you add a feature that differs across platforms.

### State + Persistence (Zustand)

All global state lives in Zustand stores with the `persist` middleware. Stores are validated with Zod schemas in `src/lib/shared/store-validators.ts`.

- **Web** — `src/lib/shared/dexie-storage.ts` (IndexedDB via Dexie).
- **Desktop** — `src/lib/shared/secure-storage.ts` (encrypted electron-store via IPC; key wrapped by Electron `safeStorage` → OS keychain).
- **The legacy localStorage adapter has been removed.** Don't add new persistence through `window.localStorage`.

Stores: `useRequestStore` (tabs[] + activeTabId — multi-tab model), `useCollectionStore`, `useEnvironmentStore`, `useHistoryStore`, `useSettingsStore`, `useWorkflowStore`, `useKafkaStore`, `useCollectionRunStore` (persisted run history, Dexie `collectionRuns`), AI store (`src/features/ai/store.ts`).

**Secret handling — `SecretRef` (ADR-0007).** Secret-bearing auth fields are migrating from plaintext `string` to `SecretValue = string | SecretRef`, where `SecretRef` is `{ kind: 'inline'; value }` or `{ kind: 'handle'; id; label? }`. With a `handle`, the renderer **never sees the plaintext** — `electron/main/security/secret-handle-store.ts` (electron-store + `safeStorage`) holds the encrypted value and resolves it only at wire-signing time in the main process. This keeps secrets out of the Zustand store, Dexie/electron-store persistence, exported collections, crash logs, and the MCP-server's agent-readable surface. Migration is incremental (per-descriptor); see `docs/adr/0007-secret-ref-pattern.md` and `electron/main/security/collection-export-redactor.ts`.

### Electron main process (`electron/main/`)

The main process is organised into purpose-based subfolders. Files that compute `__dirname`-relative paths at runtime (preload location, bundled resources, `dist/web/index.html`) **must stay at the `electron/main/` root** — moving them into a subfolder adds a path segment that nothing in `tsc` or the unit tests catches (only a packaged/e2e run would). See the NOTE block in `window-manager.ts`.

- **Root (`electron/main/`)** — the `__dirname`-sensitive entry points:
  - `main.ts` — entry / orchestrator. Owns the `IPC_MODULES` registry that couples each handler's `register` to its `dispose`, so teardown can't drift out of sync with registration.
  - `window-manager.ts` — loads `http://localhost:5173` in dev, `dist/web/index.html` in prod; resolves resource/icon paths.
  - `preload.ts` — context-isolated IPC bridge (`window.electron`); bundled by esbuild (`electron:bundle-preload`) so the sandboxed preload is self-contained. Channel names come from `electron/shared/channels.ts`; the exposed surface is type-checked against `electron/types/electron-api.ts` via `satisfies ElectronAPI`.
  - `notifications.ts` — native notifications + its rate limiter.

- **`handlers/`** — one handler per protocol/concern: `http-handler.ts`, `grpc-handler.ts`, `grpc-reflection-handler.ts`, `websocket-handler.ts`, `socketio-handler.ts`, `sse-handler.ts`, `mcp-handler.ts`, `kafka-handler.ts`, `mqtt-handler.ts`, `ai-handler.ts`, `ai-lab-handler.ts`, `mcp-server-handler.ts` (+ `mcp-context-loader.ts`), `mock-server-handler.ts`, `git-handler.ts`, plus shared helpers `interceptor-registry.ts`, `channel-event-bridge.ts`, `fetch-fetcher.ts`, `grpc-connect.ts`, `grpc-credentials.ts`, `kafka-serde.ts`, `sse-parser.ts`.

- **`ipc/`** — the IPC boundary: `ipc-validators.ts` + `ipc-rate-limiter.ts` (input validation and rate limits; legacy rate-limiter API deprecated, see ADR-0006), `ipc-utils.ts`, `rate-limiter-cleanup.ts`, and `connection-cleanup.ts` — idempotent renderer-`destroyed` listener dedupe (`bindRendererCleanup`) + walk-and-dispose helper (`disposeByOwner`). These are composed by `stream-registry.ts` (`StreamRegistry`) — the shared connection bookkeeping every streaming handler (SSE, WebSocket, Socket.IO, Kafka, MQTT, gRPC streams, MCP) builds on: the connection map, same-id replace (`add`) / reject-on-duplicate (`tryAdd`), renderer-destroyed cleanup, templated per-connection `emit`, and `disposeAll`. Protocol policy (rate limits, caps, transport, per-protocol teardown) stays in each handler; `dispose(entry)` is the seam a handler plugs its teardown into.

- **`security/`** — outbound-safety and secret handling:
  - `dns-guard.ts` — pre-flight SSRF guard. `assertHostnameSafe` / `assertUrlHostnameSafe` resolve the hostname and call `assertResolvedAddressAllowed` from `shared/protocol/url-validation` against every record. Pre-flight only — does NOT mitigate true DNS-rebind (TTL=0 swap during connect).
  - `safe-connect.ts` — SSRF-guarded `net`/`tls` connect helper shared by streaming handlers; `auth-applier.ts` — applies resolved auth/secrets to outbound requests; `aws-sigv4-smithy.ts`, `env-proxy.ts`, `collection-export-redactor.ts`.
  - `kafka-broker-guard.ts`, `mqtt-broker-guard.ts` — broker-address SSRF guards for the Kafka/MQTT handlers.
  - `secret-handle-store.ts`, `encrypted-key.ts`, `keychain-status-handler.ts` — `SecretRef` handle store + key management (see ADR-0007).

- **`storage/`** — persistence bridge: `store-handler.ts`, `collection-manager.ts` (encryption key fetched from OS keychain via `safeStorage`; warns at startup if unavailable), `vault-handler.ts`, `file-operations.ts` (async fs helpers).

- **`lifecycle/`** — app lifecycle and ops: `request-logger.ts`, `logging.ts`, `deep-link-handler.ts`, `auto-updater.ts`, `menu.ts`, `system-tray.ts`, `window-controls.ts`, `sentry.ts` + `telemetry-consent.ts` (opt-out error reporting — on by default, disabled in Settings).

- **`util/`** — small shared helpers (e.g. `debounce.ts`).

Electron-only capabilities (PAC resolution, SOCKS4/5, mTLS, custom CA, pre-flight DNS guard via `security/dns-guard.ts`, manual redirect handling) live inside the Electron fetcher closure — **not** in `shared/protocol/`. Keep `shared/` backend-agnostic. See `docs/adr/0006-electron-connection-and-dns-hardening.md` for the cleanup/DNS-guard design.

### Worker (`worker/`)

Hono app (`createApp` in `worker/app.ts`, composed with Cloudflare adapters in `worker/index.ts`) deployed as Cloudflare Pages Functions. Routes: `/health`, `/ready`, `/api/proxy`, `/api/grpc`, `/api/grpc/reflection`, `/api/mcp`, `/api/telemetry/error`, `/api/feature-flags`, `/api/ws-ticket`, `/api/ws`. The same `createApp` is reused by the Node/Docker entry (`worker/node-entry.ts`). Notable bits:

- The web build (`@cloudflare/vite-plugin`, active only when **not** an Electron/Docker build) emits the SPA to `dist/web/client/` and the Worker bundle + `wrangler.json` to `dist/web/restura/` — the two `npm run deploy` targets.
- `nodejs_compat` flag enabled (for `Buffer` etc.) — see `wrangler.jsonc`.
- Worker-only feature: upstream-proxy via the Cloudflare Sockets API in `worker/shared/tcp-proxy.ts`.
- Rate limiting in `worker/middleware/rateLimiter.ts`.
- **Auth gate**: production requires `WORKER_PROXY_TOKEN` or `REQUIRE_CF_ACCESS=true` (secrets). Local dev bypasses auth only when (a) Miniflare is running (auto-detected via `globalThis.MINIFLARE`), or (b) `DEV_BYPASS_AUTH=true` in `.dev.vars`. **Never** put `DEV_BYPASS_AUTH` in `wrangler.jsonc` (the deployed config).
- `ENVIRONMENT` var gates `allowLocalhost` in URL validation. Set to `development` in `.dev.vars` to proxy localhost during local iteration. e2e tests rely on `.dev.vars` existing **before** the dev server boots — `playwright.config.ts` bootstraps this synchronously at config-load time.

### Echo test server (`echo/`)

A separate Cloudflare Worker (`echo/wrangler.jsonc`) used by e2e tests as a controlled upstream. Handlers for HTTP, GraphQL, SSE, WebSocket, and Connect/gRPC. Deploy with `npm run deploy:echo`. Not part of the production app.

### Local echo stack (`echo-local/`)

A developer-facing, full-protocol local upstream for manually testing the **desktop** client — what `echo/` (web-only) can't host: native gRPC, real Kafka/MQTT brokers, mTLS, and a local CA. `npm run echo:local` boots the in-process protocols on stable ports (see `echo-local/ports.ts`), reusing the `e2e/mocks/*` factories + `scripts/grpc-dev-server.mjs` in place; it generates a manifest, a local CA + client cert (for `customCa`/mTLS), and an importable OpenCollection. Kafka (Redpanda) and MQTT (EMQX — the client defaults to MQTT 5, which the pure-JS Aedes can't serve) run via `docker compose -f echo-local/docker-compose.yml up`. Not part of the production app. See `echo-local/README.md`.

### CLI subproject (`cli/`)

Standalone npm package `@restura/cli` (separate `package.json`, built with `tsup`). Runs collections in CI with JUnit/HTML/JSON reporters. Self-contained — has its own deps and tests.

### Docs site (`docs-site/`)

Standalone documentation site (`@restura/docs-site`, deployed to docs.restura.dev) with its own `package.json`. Scripts from repo root: `npm run docs:dev`, `docs:build`, `docs:check`, `deploy:docs`. Not part of the production app build.

## Key Technical Patterns

- **Path alias** `@/` → `./src/` (configured in `tsconfig.json` and `vitest.config.ts`).
- **Build tool**: Vite 8 + `@vitejs/plugin-react` + `@cloudflare/vite-plugin`. The Cloudflare plugin boots Miniflare during `vite dev` so one command runs both SPA and Worker. Config is `vite.config.mts` (must be ESM — the Cloudflare plugin is ESM-only).
- **Tailwind v4** via `@tailwindcss/vite` (no separate PostCSS config).
- **Lazy components**: `src/lib/shared/lazyComponent.tsx` wraps `React.lazy` + `Suspense` (mirrors `next/dynamic` ergonomics — `next/dynamic` was removed).
- **Strict TS**: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`. `exactOptionalPropertyTypes` is **off** intentionally.
- **UI** — Radix UI primitives + Tailwind, shadcn/ui patterns in `src/components/ui/`.
- **Script sandbox** — pre-request and test scripts run in QuickJS WASM (`src/features/scripts/lib/scriptExecutor.ts`). No DOM, no filesystem, no network escape; memory + execution-time capped.
- **Collection import/export** — Postman v2.1, Insomnia, and OpenCollection (`src/lib/opencollection/`, with codegen — `spec-types.ts` is generated, validated by `verify:opencollection-types`).
- **Multiple tsconfigs** — `tsconfig.json` (renderer), `electron/tsconfig.json` (main), `worker/tsconfig.json` (Worker), `echo/tsconfig.json` (echo), `cli/tsconfig.json` (CLI), plus `src/features/http/tsconfig.json`. `tsconfig.base.json` holds shared compiler options. **`npm run type-check` only covers the renderer** — the root `tsconfig.json` excludes `worker`, `electron/main`, and `cli`, so a green `type-check` does _not_ mean those projects compile. Use **`npm run type-check:all`** (chained into `npm run validate`) to type-check every project the way CI does. `npm run lint` does cover all of them.

## Testing

- **Unit/integration**: Vitest in jsdom, colocated `*.test.ts(x)` files. Setup in `tests/setup.ts`. React Testing Library for components.
- **e2e**: Playwright in `e2e/`. Tests prefixed `real-*` hit live upstreams (or the local echo server); `playwright.config.ts` boots the dev server via its `webServer` config. `workers: 1` and `fullyParallel: false` are deliberate — multiple suites share dev server state. `e2e/global-setup.ts` and `bootstrapPrereqs()` ensure `.dev.vars` exists before Miniflare reads it (load-bearing).
- **Security tests**: `tests/security/` for SSRF, header policy, redirect handling regressions.

## Electron Build

`electron-builder.json` defines the build. Process:

1. `electron:build:web` — `vite build` with `VITE_IS_ELECTRON_BUILD=true` → `dist/web/`
2. `electron:compile` — Compiles `electron/main/` TypeScript → `dist/electron/`
3. `electron-builder` — Packages from `dist/` per target (`electron:dist:{mac,win,linux}`)

The renderer entry is `dist/web/index.html` loaded via `file://` with hash routing. `_worker.js` is excluded from the Electron bundle.

## Agent loop playbook

How to run agentic work in this repo (loop primitives → repo tooling):

Codex uses the matching skills in `.agents/skills/`, read-only review agents in
`.codex/agents/`, and lifecycle hooks documented in `.codex/README.md`.

- **Verify before declaring done** — for any renderer/UI change, use the `verify-ui-change` skill (dev server + real browser + console check). An edit that compiles is not a verified change.
- **Goal loops** — `/fix-until-green [attempts]` iterates until the coverage-aware local gate `npm run validate` passes with a hard cap (or `/goal make npm run validate pass, stop after 5 tries`). Deterministic exit criteria beat "looks done".
- **Time loops** — `/babysit-prs` is one idempotent iteration of PR care (CI fixes, review comments); drive it with `/loop 15m /babysit-prs` locally, or `subscribe_pr_activity` in remote sessions (events beat polling).
- **Proactive loops** — `/triage-maintenance` sweeps dependabot PRs, security-audit findings, and skill metrics in one pass; pilot manually, then `/schedule` it.
- **Pre-PR gate** — `/ship-check` fans out the review agents (`restura-security-auditor`, `restura-parity-checker`, `restura-docs-steward`) **in parallel** plus a fresh-context `/code-review`.
- **Complete CI verdict** — the `merge-gate` job aggregates validation, docs, browser and Electron E2E, both extensions, and cross-OS Electron packaging. Local `validate` is necessary but does not replace it.
- **Release proof** — release preflight waits for a successful `merge-gate` on the exact candidate SHA before publishing.
- **Parallel sessions** — independent fixes get independent sessions in separate git worktrees (one topic per branch/PR); don't stack unrelated fixes serially on one branch.
- **When a loop's output misses the bar**: don't just fix the instance — encode the fix (skill, hook, command, CLAUDE.md note) so every future iteration inherits it.

## Summary instructions (for context compaction)

When this conversation is summarized to free context, **preserve** the following — they are load-bearing for Restura work and expensive to reconstruct:

- **The task objective and acceptance criteria**, and which **harness(es)** are in scope: web (Cloudflare Worker), self-host (Node entry), Electron (IPC). Parity across them is the #1 bug class — never drop "this also needs the other harness wired."
- **Files read or modified**, and any pending edits not yet applied.
- **Security-boundary decisions**: SSRF/`url-validation` changes, new outbound transports, Electron IPC validation (`createValidatedHandler`), DNS/broker guards, `SecretRef` handling. These must survive summarization verbatim.
- **Gate results and failures** with `file:line`: `type-check:all` (not just renderer `type-check`), `lint`, the security suite, `capabilities:check`, `verify:opencollection-types`.
- **Codegen state**: whether `capabilities.ts` → `CAPABILITY_MATRIX.md` or the OpenCollection types still need regenerating (never hand-edit the generated files).
- **Decisions and their reasoning**, especially any ADR that the change warrants.

Drop verbose tool output (full file dumps, passing test logs) before dropping any of the above.
