# AGENTS.md

This file provides guidance to Codex when working with code in this repository.
It mirrors `CLAUDE.md` for the Codex runtime; `CLAUDE.md` is the fuller,
actively-maintained reference — when in doubt, read it. Keep the two in sync:
an architectural change documented in one should be reflected in the other.

Codex MCP context lives in `.codex/config.toml` (chrome-devtools, next-devtools).

## Project Overview

Restura is a multi-protocol API client supporting **HTTP/REST, GraphQL, gRPC,
WebSocket, Socket.IO, SSE, Kafka, MQTT, and MCP** (Model Context Protocol), plus
an **AI assistant** that can read request context. It ships from a single React
renderer to **three** targets: a web app (Cloudflare Pages + Workers), a
self-hostable Node/Docker server, and an Electron desktop app. Restura can also
act _as_ an MCP server (`src/features/mcp-server`). Node.js 24+ required.

## Development Commands

```bash
# Web development (Vite + Cloudflare Worker via Miniflare)
npm run dev                    # Start Vite dev server (port 5173) — boots the Worker locally too
npm run build                  # Production build (SPA + Worker bundle)
npm run preview                # Preview production build
npm run type-check             # TypeScript strict mode — RENDERER ONLY (excludes worker, electron/main, cli)
npm run type-check:all         # Full type-check across all tsconfigs — what CI runs
npm run lint                   # ESLint over src/ shared/ electron/main/ worker/ echo/ echo-local/ cli/ tests/ scripts/
npm run format                 # Prettier write
npm run format:check           # Prettier check

# Worker / Node API (shared Hono app — Cloudflare + self-host)
npx tsc --noEmit -p worker/tsconfig.json    # Type-check the Worker independently

# Testing
npm run test                   # Vitest interactive mode
npm run test:run               # Single test run
npm run test:coverage          # Coverage report
npm run test:e2e               # Playwright (boots dev server; needs .dev.vars)

# Full validation (matches CI) — NOT just type-check+lint+test
npm run validate               # type-check:all → lint → format:check → verify:opencollection-types → capabilities:check → test:run → cli test

# Self-hosted Node / Docker server (single process: SPA + /api/* on one port)
npm run build:docker           # SPA → dist/web + esbuild Worker → dist/server/index.mjs
npm run start                  # node dist/server/index.mjs (PORT/HOST/RESTURA_STATIC_ROOT env-tunable)

# Electron desktop app
npm run electron:dev           # Dev mode (Vite + Electron)
npm run electron:compile       # Compile main process TS → dist/electron/
npm run electron:build:web     # Build the renderer for Electron
npm run electron:dist:{mac,win,linux}    # Package distributables

# Cloudflare Pages deploy
npm run deploy                 # Deploy production (Worker + Pages)
npm run deploy:preview         # Deploy preview
```

> **Trap**: plain `npm run type-check` only covers the renderer. The Electron
> main process, Worker, and CLI are separate `tsc` projects — use
> `npm run type-check:all` to type-check the way CI does. The pre-commit hook
> runs only lint-staged (eslint + prettier on staged files); it does **not**
> run tsc or tests.

## Architecture

### Multi-Platform: One Renderer, Three Backends

The same Vite-built React SPA serves all targets; the transport layer is the
only thing that differs, chosen at runtime by `isElectron()` in
`src/lib/shared/platform.ts`. The two HTTP backends (Cloudflare Worker and
Node/Docker server) share a single Hono app via the `createApp(deps)` factory in
`worker/app.ts`; each entry supplies its own platform adapters.

- **Web** — SPA on Cloudflare Pages → fetch `/api/*` → Cloudflare Worker (Hono)
  at `worker/index.ts`. Same-origin, no CORS.
- **Self-hosted** — `worker/node-entry.ts` runs `createApp` in one Node process
  serving both the SPA (`dist/web`) and `/api/*`. Node-native adapters live in
  `worker/shared/*-node.ts` and `worker/handlers/websocket-node.ts`. See
  `docs/SELF_HOSTING.md`.
- **Desktop** — SPA via `file://` → IPC over `window.electron` (preload bridge)
  → Electron main handlers in `electron/main/handlers/*-handler.ts`. The Worker
  is **never** bundled into the desktop app.
- **Routing** — `createHashRouter` so the renderer works under both `https://`
  (Pages) and `file://` (Electron).

### Shared protocol core (`shared/protocol/`) — read this first

Each protocol (HTTP, gRPC, MCP, SSE, WebSocket, AI) is implemented **once** as a
backend-agnostic orchestrator. Each backend (Worker, Node server, Electron main)
supplies only a thin `Fetcher` adapter; everything else — SSRF validation,
header sanitisation, body construction, response shape, status mapping, SSE/
NDJSON parsing — lives in `shared/protocol/` and runs identically across all of
them. Key modules: `url-validation.ts` (single-source SSRF guard),
`header-policy.ts`, `body-builder.ts`, `types.ts`, `{http,grpc,mcp,websocket}-proxy.ts`,
`ai/` (AI chat orchestrator + per-provider decoders), `auth-signer.ts`,
`secret-value-schema.ts`.

**Adding a new protocol**: add `shared/protocol/<name>-proxy.ts` exposing
`execute<Name>Proxy(spec, fetcher, options)`, then ~30 lines of Fetcher adapter
each in `worker/handlers/` and `electron/main/handlers/`. SSRF, headers, body,
timeouts come for free. Keep `shared/` backend-agnostic — Electron-only
capabilities (PAC, SOCKS, mTLS, custom CA, DNS guard) live in the Electron
fetcher closure.

### Feature-Based Organization

```
src/features/{http,grpc,graphql,websocket,socketio,sse,mcp,kafka,mqtt}   # protocol features
src/features/ai            # AI assistant (chat + request-context tooling; Electron-first)
src/features/ai-lab        # Electron-only LLM/prompt testing & eval workbench
src/features/mcp-server    # Restura-as-MCP-server
src/features/load-testing  # collection load/perf runner
src/features/{collections,environments,workflows,scripts,auth,registry,contracts}
src/components/{ui,shared,providers}
src/routes/                # React Router route components
src/lib/shared/            # platform, encryption, storage, validators, capabilities, etc.
```

Each protocol feature exports a `protocol.ts` describing its schema, and its
executor branches on `isElectron()` to pick IPC vs. HTTP transport.

> **Capability parity is data-driven.** `src/lib/shared/capabilities.ts` is the
> single source of truth for which features work on web vs. desktop (Kafka,
> SOCKS/PAC/mTLS are desktop-only — no browser TCP). It is codegen'd into
> `docs/CAPABILITY_MATRIX.md` and gated by `npm run capabilities:check`. Update
> `capabilities.ts` (not the doc) and run `npm run capabilities:matrix`.

### State + Persistence (Zustand)

All global state lives in Zustand stores with the `persist` middleware,
validated with Zod schemas in `src/lib/shared/store-validators.ts`.

- **Web** — `src/lib/shared/dexie-storage.ts` (IndexedDB via Dexie).
- **Desktop** — `src/lib/shared/secure-storage.ts` (encrypted electron-store via
  IPC; key wrapped by Electron `safeStorage` → OS keychain).
- **The legacy localStorage adapter has been removed.** Don't add new
  persistence through `window.localStorage`.

Stores: `useRequestStore` (multi-tab), `useCollectionStore`,
`useEnvironmentStore`, `useHistoryStore`, `useSettingsStore`, `useWorkflowStore`,
`useKafkaStore`, `useCollectionRunStore`, and the AI store.

**Secrets — `SecretRef` (ADR-0007).** Secret-bearing auth fields are migrating
from plaintext `string` to `SecretValue = string | SecretRef`. With a `handle`,
the renderer never sees the plaintext — `electron/main/security/secret-handle-store.ts`
holds the encrypted value and resolves it only at wire-signing time in main.

### Electron main process (`electron/main/`)

Organized into purpose-based subfolders. Files that compute `__dirname`-relative
paths (`main.ts`, `window-manager.ts`, `preload.ts`) **must stay at the
`electron/main/` root**.

- **`handlers/`** — one handler per protocol/concern: `http-handler.ts`,
  `grpc-handler.ts`, `websocket-handler.ts`, `sse-handler.ts`, `mcp-handler.ts`,
  `kafka-handler.ts`, `mqtt-handler.ts`, `ai-handler.ts`, `ai-lab-handler.ts`,
  `mcp-server-handler.ts`, etc.
- **`ipc/`** — the IPC boundary: validators, rate-limiter, stream-registry,
  connection-cleanup.
- **`security/`** — `dns-guard.ts` (pre-flight SSRF), `safe-connect.ts`,
  `kafka-broker-guard.ts`/`mqtt-broker-guard.ts`, `secret-handle-store.ts`.
- **`storage/`**, **`lifecycle/`**, **`util/`** — persistence bridge, app
  lifecycle/ops, small helpers.

The renderer's executors branch on `isElectron()` to use IPC instead of HTTP.
New IPC methods need **all three**: a Zod schema + `createValidatedHandler` in
`electron/main/ipc/ipc-validators.ts`, the preload bridge in `preload.ts`, and a
type declaration checked against `electron/types/electron-api.ts` — or the call
breaks at runtime on desktop.

### Worker (`worker/`)

Hono app (`createApp` in `worker/app.ts`, composed with Cloudflare adapters in
`worker/index.ts`), deployed as Cloudflare Pages Functions and reused by the
Node/Docker entry. Routes: `/health`, `/ready`, `/api/proxy`, `/api/grpc`,
`/api/grpc/reflection`, `/api/mcp`, `/api/ws`, and more.

- Bundled into `dist/web/restura/` by `@cloudflare/vite-plugin` during build.
- `nodejs_compat` flag enabled for `Buffer` etc. (see `wrangler.jsonc`).
- **Auth gate**: production requires `WORKER_PROXY_TOKEN` or
  `REQUIRE_CF_ACCESS=true`. Local dev bypasses auth only under Miniflare or with
  `DEV_BYPASS_AUTH=true` in `.dev.vars` — never put `DEV_BYPASS_AUTH` in
  `wrangler.jsonc`.
- The `ENVIRONMENT` var gates `allowLocalhost` in URL validation. Set to
  `development` in `.dev.vars` to proxy localhost locally.

### Key Technical Patterns

- **Path alias** `@/` → `./src/`. Cross-feature imports are discouraged —
  compose at the route or shared-component level.
- **Build**: Vite 8 + `@vitejs/plugin-react` + `@cloudflare/vite-plugin`
  (boots Miniflare during `vite dev`). Config is `vite.config.mts` (ESM-only).
- **Tailwind v4** via `@tailwindcss/vite` (no separate PostCSS config).
- **Strict TS**: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`,
  `noUncheckedIndexedAccess`. `exactOptionalPropertyTypes` is off intentionally.
- **Script sandbox**: pre-request/test scripts run in QuickJS WASM
  (`src/features/scripts/lib/scriptExecutor.ts`).
- **Collection import/export**: Postman v2.1, Insomnia, and OpenCollection
  (`src/lib/opencollection/`, with codegen — `spec-types.ts` is generated and
  gated by `verify:opencollection-types`; never hand-edit it).
- **Multiple tsconfigs**: renderer, `electron/`, `worker/`, `echo/`, `cli/`,
  plus `src/features/http/`. `tsconfig.base.json` holds shared options.

## Worker deploy facts

- The Electron build excludes `_worker.js` (see `electron-builder.json` files glob).
- Rate limiting in `worker/middleware/rateLimiter.ts`; SSRF guard shared from
  `shared/protocol/url-validation.ts`.

## Testing

Tests are colocated under `__tests__/` using `*.test.ts(x)`. Vitest runs in
jsdom with React Testing Library; setup in `tests/setup.ts`. Vitest globals are
enabled. Security regressions live in `tests/security/` (SSRF, header policy,
redirects). e2e specs are in `e2e/` (Playwright); `real-*` specs hit live
upstreams or the local echo server. Coverage thresholds gate the test job.

## Electron Build

`electron-builder.json` defines the build:

1. `electron:build:web` — `vite build` with `VITE_IS_ELECTRON_BUILD=true` → `dist/web/`
2. `electron:compile` — Compiles `electron/main/` TypeScript → `dist/electron/`
3. `electron-builder` — Packages from `dist/` per target.

The renderer entry is `dist/web/index.html` loaded via `file://` with hash
routing. The Electron main process has its own `tsconfig.json` at
`electron/tsconfig.json`.
