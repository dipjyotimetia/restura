# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Restura is a multi-protocol API client supporting **HTTP/REST, GraphQL, gRPC, WebSocket, SSE, and MCP** (Model Context Protocol). It ships as both a web app (Cloudflare Pages + Workers) and an Electron desktop app from a single React renderer. Node.js 22+ required.

## Development Commands

```bash
# Web development (Vite + Cloudflare Worker via Miniflare)
npm run dev                    # Start Vite dev server (port 5173) — boots the Worker locally too
npm run build                  # Production build (SPA + Worker bundle)
npm run preview                # Preview production build
npm run type-check             # TypeScript strict mode (all tsconfigs)
npm run lint                   # ESLint over src/ electron/main worker/ echo/
npm run lint:fix               # ESLint --fix
npm run format                 # Prettier write
npm run format:check           # Prettier check

# Cloudflare Worker (web-only API)
npx tsc --noEmit -p worker/tsconfig.json    # Type-check Worker independently

# Testing
npm run test                   # Vitest interactive
npm run test:run               # Vitest single run
npm run test:watch             # Vitest watch
npm run test:coverage          # Coverage report
npm run test:e2e               # Playwright (boots dev server via webServer; needs .dev.vars)
npm run test:e2e:ui            # Playwright UI mode
npm run test:e2e:headed        # Playwright headed
vitest run path/to/file.test.ts                  # Run a single Vitest file
vitest run -t "test name pattern"                # Filter by test name
npx playwright test e2e/real-http.spec.ts        # Run a single e2e spec

# Full validation (matches CI)
npm run validate               # type-check + lint + verify:opencollection-types + test:run

# Generated code
npm run proto:gen                       # buf generate (regenerates protobuf TS)
npm run gen:opencollection-types        # Regenerate OpenCollection JSON Schema → TS
npm run verify:opencollection-types     # Generate + fail if diff (CI gate)

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

### Dual-Platform: One Renderer, Two Transports

The same Vite-built React SPA serves both targets. The transport layer is the only thing that differs — chosen at runtime by `isElectron()` in `src/lib/shared/platform.ts`.

- **Web** — SPA on Cloudflare Pages → fetch `/api/*` → Cloudflare Worker (Hono) at `worker/index.ts` → upstream. Same-origin, no CORS friction.
- **Desktop** — SPA loaded via `file://` → IPC over `window.electronAPI` (preload bridge) → Electron main process handlers in `electron/main/*-handler.ts` → upstream. The Worker is **never** bundled into the desktop app (`electron-builder.json` files glob excludes `_worker.js`).
- **Routing** — `createHashRouter` so the renderer works under both `https://` (Pages) and `file://` (Electron). There is no server-side routing.

### Shared protocol core (`shared/protocol/`) — read this first

This is the most important architectural piece in the repo. Each protocol (HTTP, gRPC, MCP, SSE) is implemented **once** as a backend-agnostic orchestrator. The Worker and the Electron main process each supply only a thin `Fetcher` adapter; everything else — SSRF validation, header sanitisation, body construction, response shape, gRPC status mapping, SSE/NDJSON parsing — lives in `shared/protocol/` and runs identically on both backends.

```
                    shared/protocol/{http,grpc,mcp,sse}-proxy.ts
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
- `shared/protocol/http-proxy.ts`, `grpc-proxy.ts`, `mcp-proxy.ts`, `sse-parser.ts`, `ndjson-parser.ts`.
- `shared/protocol/auth-signer.ts`, `oauth1-signer.ts`, `wsse-header.ts` — auth signing **at the wire** (Worker/Electron, not the renderer) so signatures match exact upstream bytes.

**When adding a new protocol**: add `shared/protocol/<name>-proxy.ts` exposing `execute<Name>Proxy(spec, fetcher, options)`, then ~30 lines of Fetcher adapter each in `worker/handlers/` and `electron/main/`. SSRF, headers, body, timeouts come for free.

### Feature-based renderer layout (`src/features/`)

Each feature module owns its components, hooks, lib (executors/clients), and store. Protocol features (`http/`, `grpc/`, `graphql/`, `websocket/`, `sse/`, `mcp/`) follow the same shape and export a `protocol.ts` describing their schema. The renderer's executor in each feature branches on `isElectron()` to pick IPC vs. HTTP transport — no behavioural difference.

```
src/features/{http,grpc,graphql,websocket,sse,mcp}   # protocol features
src/features/{collections,environments,workflows,scripts,auth,registry}
src/components/{ui,shared,providers}
src/routes/                                          # React Router route components
src/lib/shared/                                      # platform, encryption, storage, validators, etc.
src/lib/opencollection/                              # OpenCollection spec import/export (generated types)
```

### State + Persistence (Zustand)

All global state lives in Zustand stores with the `persist` middleware. Stores are validated with Zod schemas in `src/lib/shared/store-validators.ts`.

- **Web** — `src/lib/shared/dexie-storage.ts` (IndexedDB via Dexie).
- **Desktop** — `src/lib/shared/secure-storage.ts` (encrypted electron-store via IPC; key wrapped by Electron `safeStorage` → OS keychain).
- **The legacy localStorage adapter has been removed.** Don't add new persistence through `window.localStorage`.

Stores: `useRequestStore` (tabs[] + activeTabId — multi-tab model), `useCollectionStore`, `useEnvironmentStore`, `useHistoryStore`, `useSettingsStore`, `useWorkflowStore`.

### Electron main process (`electron/main/`)

One handler per protocol/concern: `http-handler.ts`, `grpc-handler.ts`, `grpc-reflection-handler.ts`, `websocket-handler.ts`, `socketio-handler.ts`, `sse-handler.ts`, `mcp-handler.ts`. Plus:

- `main.ts` — entry / orchestrator
- `window-manager.ts` — loads `http://localhost:5173` in dev, `dist/web/index.html` in prod
- `preload.ts` — context-isolated IPC bridge (`window.electronAPI`)
- `ipc-validators.ts` + `ipc-rate-limiter.ts` — input validation and rate limits at the IPC boundary (legacy rate-limiter API deprecated; see ADR-0006)
- `connection-cleanup.ts` — idempotent renderer-`destroyed` listener dedupe (`bindRendererCleanup`) + walk-and-dispose helper (`disposeByOwner`). Shared by every long-lived streaming handler.
- `dns-guard.ts` — pre-flight SSRF guard. `assertHostnameSafe` / `assertUrlHostnameSafe` resolve the hostname and call `assertResolvedAddressAllowed` from `shared/protocol/url-validation` against every record. Pre-flight only — does NOT mitigate true DNS-rebind (TTL=0 swap during connect).
- `store-handler.ts`, `collection-manager.ts` — persistent storage bridge (encryption key fetched from OS keychain via `safeStorage`; warns at startup if unavailable)
- `interceptor-registry.ts`, `request-logger.ts`, `deep-link-handler.ts`, `auto-updater.ts`, `menu.ts`, `system-tray.ts`, `notifications.ts`, `window-controls.ts`
- `file-operations.ts` — async fs helpers (no behavioral change; was sync)

Electron-only capabilities (PAC resolution, SOCKS4/5, mTLS, custom CA, pre-flight DNS guard via `dns-guard.ts`, manual redirect handling) live inside the Electron fetcher closure — **not** in `shared/protocol/`. Keep `shared/` backend-agnostic. See `docs/adr/0006-electron-connection-and-dns-hardening.md` for the cleanup/DNS-guard design.

### Worker (`worker/`)

Hono app deployed as Cloudflare Pages Functions. Routes: `/api/proxy`, `/api/grpc`, `/api/grpc/reflection`, `/api/mcp`. Notable bits:

- Bundled into `dist/web/_worker.js` by `@cloudflare/vite-plugin` during `vite build`.
- `nodejs_compat` flag enabled (for `Buffer` etc.) — see `wrangler.jsonc`.
- Worker-only feature: upstream-proxy via the Cloudflare Sockets API in `worker/shared/tcp-proxy.ts`.
- Rate limiting in `worker/middleware/rateLimiter.ts`.
- **Auth gate**: production requires `WORKER_PROXY_TOKEN` or `REQUIRE_CF_ACCESS=true` (secrets). Local dev bypasses auth only when (a) Miniflare is running (auto-detected via `globalThis.MINIFLARE`), or (b) `DEV_BYPASS_AUTH=true` in `.dev.vars`. **Never** put `DEV_BYPASS_AUTH` in `wrangler.jsonc` (the deployed config).
- `ENVIRONMENT` var gates `allowLocalhost` in URL validation. Set to `development` in `.dev.vars` to proxy localhost during local iteration. e2e tests rely on `.dev.vars` existing **before** the dev server boots — `playwright.config.ts` bootstraps this synchronously at config-load time.

### Echo test server (`echo/`)

A separate Cloudflare Worker (`echo/wrangler.jsonc`) used by e2e tests as a controlled upstream. Handlers for HTTP, GraphQL, SSE, WebSocket, and Connect/gRPC. Deploy with `npm run deploy:echo`. Not part of the production app.

### CLI subproject (`cli/`)

Standalone npm package `@restura/cli` (separate `package.json`, built with `tsup`). Runs collections in CI with JUnit/HTML/JSON reporters. Self-contained — has its own deps and tests.

## Key Technical Patterns

- **Path alias** `@/` → `./src/` (configured in `tsconfig.json` and `vitest.config.ts`).
- **Build tool**: Vite 8 + `@vitejs/plugin-react` + `@cloudflare/vite-plugin`. The Cloudflare plugin boots Miniflare during `vite dev` so one command runs both SPA and Worker. Config is `vite.config.mts` (must be ESM — the Cloudflare plugin is ESM-only).
- **Tailwind v4** via `@tailwindcss/vite` (no separate PostCSS config).
- **Lazy components**: `src/lib/shared/lazyComponent.tsx` wraps `React.lazy` + `Suspense` (mirrors `next/dynamic` ergonomics — `next/dynamic` was removed).
- **Strict TS**: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`. `exactOptionalPropertyTypes` is **off** intentionally.
- **UI** — Radix UI primitives + Tailwind, shadcn/ui patterns in `src/components/ui/`.
- **Script sandbox** — pre-request and test scripts run in QuickJS WASM (`src/features/scripts/lib/scriptExecutor.ts`). No DOM, no filesystem, no network escape; memory + execution-time capped.
- **Collection import/export** — Postman v2.1, Insomnia, and OpenCollection (`src/lib/opencollection/`, with codegen — `spec-types.ts` is generated, validated by `verify:opencollection-types`).
- **Multiple tsconfigs** — `tsconfig.json` (renderer), `electron/tsconfig.json` (main), `worker/tsconfig.json` (Worker), `echo/tsconfig.json` (echo), `cli/tsconfig.json` (CLI). `tsconfig.base.json` holds shared compiler options. `npm run type-check` and `npm run lint` cover all of them.

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
