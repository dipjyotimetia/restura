# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Restura is a multi-protocol API testing client supporting HTTP/REST, GraphQL, gRPC, WebSocket, Socket.IO, SSE, Kafka, and MCP. It runs as both a web application (Cloudflare Pages + Workers) and an Electron desktop app.

## Development Commands

```bash
# Web development (Vite + Cloudflare Worker via Miniflare)
npm run dev                    # Start Vite dev server (port 5173) — runs the Worker locally too
npm run build                  # Production build (static SPA + Worker bundle)
npm run preview                # Preview production build
npm run type-check             # TypeScript type checking (strict mode)
npm run lint                   # TypeScript validation
npm run format                 # Prettier formatting

# Worker (Cloudflare Pages Functions)
npx tsc --noEmit -p worker/tsconfig.json    # Type-check the Worker

# Testing
npm run test                   # Vitest interactive mode
npm run test:run               # Single test run
npm run test:watch             # Watch mode
npm run test:coverage          # Coverage report

# Full validation
npm run validate               # type-check + lint + test:run

# Electron desktop app
npm run electron:dev           # Dev mode (Vite + Electron)
npm run electron:compile       # Compile TypeScript for main process
npm run electron:build:web     # Build the renderer for Electron
npm run electron:dist:mac      # Build macOS app
npm run electron:dist:win      # Build Windows app
npm run electron:dist:linux    # Build Linux app

# Cloudflare Pages deploy
npm run deploy                 # Deploy production
npm run deploy:preview         # Deploy preview branch
```

## Architecture

### Dual-Platform Design
- **Web Client**: Vite + React + React Router SPA, deployed to Cloudflare Pages.
- **Worker (web only)**: Hono app at `worker/index.ts` deployed as Pages Functions, serving `/api/proxy`, `/api/grpc`, `/api/grpc/reflection`. Same-origin as the SPA — no CORS friction.
- **Desktop Client**: Electron main process at `electron/main/`. Renderer is the same Vite-built SPA loaded via `file://`. The Worker is **never** bundled into the desktop app — Electron uses native IPC (`electron/main/http-handler.ts`).
- **Routing**: `createHashRouter` so the same renderer works under `https://` (Pages) and `file://` (Electron).

### Feature-Based Organization
```
src/features/
├── http/           # RequestBuilder, requestExecutor, useHttpRequest, useCookieStore
├── grpc/           # GrpcRequestBuilder, grpcClient, grpcReflection
├── websocket/      # WebSocketClient
├── socketio/       # Socket.IO client (desktop only)
├── graphql/        # GraphQLRequestBuilder, GraphQLBodyEditor, SchemaExplorer
├── sse/            # Server-Sent Events client
├── kafka/          # Kafka producer/consumer (desktop only)
├── mcp/            # MCP client
├── collections/    # Sidebar, CollectionRunner, importers, exporters
├── environments/   # EnvironmentManager
├── auth/           # AuthConfig (shared by HTTP & gRPC)
├── scripts/        # ScriptsEditor, scriptExecutor (QuickJS sandbox)
└── workflows/      # Workflow chaining + variable extraction

src/components/
├── ui/             # Radix UI primitives (shadcn/ui patterns)
├── shared/         # Header, ResponseViewer, KeyValueEditor, CodeEditor, etc.
└── providers/      # PlatformProvider, ThemeProvider

src/routes/         # React Router route components (index, not-found)
src/lib/shared/     # utils, encryption, storage, platform, validations, lazyComponent

worker/             # Cloudflare Worker (Hono) — web-only API
├── index.ts        # Hono app, route mounting, CORS
├── handlers/       # proxy, grpc, grpc-reflection
└── shared/         # url-validation (SSRF guards), grpc-status enum
```

### State Management (Zustand)
Persisted stores manage application state:
- `useRequestStore` - Current request/response state
- `useCollectionStore` - Saved request collections
- `useEnvironmentStore` - Environment variables
- `useHistoryStore` - Request history
- `useSettingsStore` - App preferences

All stores use `zustand/middleware/persist` for localStorage persistence. Stores are validated with Zod schemas in `src/lib/shared/store-validators.ts`.

### Electron IPC Architecture
Main process modules in `electron/main/`:
- `main.ts` - Application entry, orchestrates other modules
- `window-manager.ts` - Window creation; loads `http://localhost:5173` in dev, `dist/web/index.html` in prod
- `file-operations.ts` - Native file system access
- `http-handler.ts` - Native HTTP requests (CORS-free, replaces the Worker on desktop)
- `auto-updater.ts` - App updates via electron-updater
- `preload.ts` - Secure bridge between main/renderer

The renderer's `requestExecutor` and `grpcClient` branch on `isElectron()` to use IPC instead of HTTP — so the Worker is web-only and the Electron renderer keeps working with zero behavioral change.

### Key Technical Patterns

**Path Alias**: `@/` → `./src/` (configured in `tsconfig.json` and `vitest.config.ts`)

**Build tool**: Vite 8 with `@vitejs/plugin-react` and `@cloudflare/vite-plugin`. The Cloudflare plugin runs the Worker locally via Miniflare during `vite dev` — single command boots both SPA and Worker. Config is `vite.config.mts` (ESM-only, due to `@cloudflare/vite-plugin`).

**Tailwind**: v4 via `@tailwindcss/vite` plugin (no separate PostCSS config).

**Lazy components**: `next/dynamic` was replaced by `src/lib/shared/lazyComponent.tsx` — wraps `React.lazy` + `Suspense`, mirrors `next/dynamic` ergonomics.

**Type Safety**: Strict TypeScript with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`. `exactOptionalPropertyTypes` disabled for flexibility.

**UI Components**: Radix UI primitives with custom Tailwind styling. Components in `src/components/ui/` follow shadcn/ui patterns.

**Script Execution**: Pre-request and test scripts run in QuickJS sandbox (`src/features/scripts/lib/scriptExecutor.ts`).

**Import/Export**: Postman and Insomnia collection formats via `src/features/collections/lib/{importers,exporters}.ts`.

## Worker

The Worker is a Hono app deployed as Cloudflare Pages Functions. Key facts:
- Bundled into `dist/web/_worker.js` by `@cloudflare/vite-plugin` during `vite build`.
- The Electron build excludes `_worker.js` (see `electron-builder.json` files glob).
- Compatibility flag `nodejs_compat` is enabled for `Buffer` etc. (see `wrangler.jsonc`).
- The `ENVIRONMENT` var (in `wrangler.jsonc`) gates `allowLocalhost` in URL validation. Set to `development` in `.dev.vars` for local iteration if you need to proxy localhost.

## Testing

Tests are colocated with source files using `*.test.ts` pattern. Vitest runs in jsdom environment with React Testing Library. Test setup in `tests/setup.ts`.

## Electron Build

`electron-builder.json` defines the build. Process:
1. `electron:build:web` — `vite build` with `VITE_IS_ELECTRON_BUILD=true` → `dist/web/`
2. `electron:compile` — Compiles TypeScript in `electron/main/` → `dist/electron/`
3. `electron-builder` — Packages app for target platform from `dist/`

Electron main process has its own `tsconfig.json` at `electron/tsconfig.json`. Renderer is loaded from `dist/web/index.html` (file:// in production, hash routing).
