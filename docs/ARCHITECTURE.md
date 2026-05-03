# Restura — Architecture

## Overview

Restura is a multi-protocol API testing client that ships as both a **web application** (Cloudflare Pages + Workers) and an **Electron desktop app**. The same Vite-built React SPA is the renderer for both delivery targets; only the transport layer differs.

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Browser / Desktop                       │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │          React SPA (shared renderer)                    │   │
│   │  Vite 7 · React 19 · React Router v7 (hash) · Zustand  │   │
│   └───────────────┬────────────────────┬────────────────────┘   │
│                   │ Web                │ Electron                │
│         isElectron() = false   isElectron() = true              │
│                   │                    │                         │
│   ┌───────────────▼────┐   ┌──────────▼──────────────────────┐  │
│   │  Cloudflare Worker │   │  Electron main process (Node.js) │  │
│   │  (Hono framework)  │   │  Native IPC handlers            │  │
│   └───────────────┬────┘   └──────────┬──────────────────────┘  │
│                   │                    │                         │
└───────────────────┼────────────────────┼─────────────────────────┘
                    │                    │
                    ▼                    ▼
             Target API / Service (HTTP, gRPC, WS, SSE, MCP...)
```

### Web path

```
User → Vite SPA → fetch /api/* → Cloudflare Worker (Hono) → Target API
```

The Worker runs as a Cloudflare Pages Function, co-deployed with the SPA. It handles:
- HTTP proxying (`/api/proxy`)
- gRPC unary + streaming (`/api/grpc`)
- gRPC reflection (`/api/grpc/reflection`)
- MCP server proxy (`/api/mcp`)

SSRF guards in `worker/shared/url-validation.ts` block private/localhost URLs in production.

### Electron path

```
User → Vite SPA → window.electronAPI (preload IPC) → main process handlers → Target API
```

The Electron main process exposes native handlers via a secure context-isolated preload script. No Worker is bundled; the desktop app uses Node.js APIs directly for all protocols.

---

## Technology Stack

| Concern | Technology |
|---|---|
| Build tool | Vite 7 + `@cloudflare/vite-plugin` |
| UI framework | React 19 |
| Routing | React Router v7 (`createHashRouter`) |
| Styling | TailwindCSS v4 via `@tailwindcss/vite` |
| UI components | shadcn/ui patterns on Radix UI primitives |
| State management | Zustand v5 with `persist` middleware |
| Validation | Zod v4 |
| Code editor | Monaco Editor (`@monaco-editor/react`) |
| Script sandbox | QuickJS WASM (`quickjs-emscripten`) |
| gRPC (web) | `@connectrpc/connect-web` + `@bufbuild/protobuf` |
| gRPC (desktop) | `@grpc/grpc-js` + `@grpc/proto-loader` |
| Worker framework | Hono |
| Desktop shell | Electron 41 |
| Auto-updates | `electron-updater` |
| Testing | Vitest + React Testing Library |
| Deployment | Cloudflare Pages + Functions |

---

## Project Structure

```
restura/
│
├── src/                          # Renderer source (shared by web and desktop)
│   ├── features/                 # Feature modules (co-located components, hooks, stores)
│   │   ├── http/                 # HTTP/REST: RequestBuilder, requestExecutor, useHttpRequest, useCookieStore
│   │   ├── grpc/                 # gRPC: GrpcRequestBuilder, grpcClient, grpcReflection
│   │   ├── websocket/            # WebSocket: WebSocketClient
│   │   ├── graphql/              # GraphQL: GraphQLRequestBuilder, GraphQLBodyEditor, SchemaExplorer
│   │   ├── sse/                  # Server-Sent Events client
│   │   ├── mcp/                  # Model Context Protocol client
│   │   ├── workflows/            # Request chaining, variable extraction, retry policies
│   │   ├── collections/          # Sidebar, CollectionRunner, importers, exporters
│   │   ├── environments/         # EnvironmentManager
│   │   ├── auth/                 # AuthConfig (shared by HTTP & gRPC)
│   │   └── scripts/              # ScriptsEditor, scriptExecutor (QuickJS sandbox)
│   │
│   ├── components/
│   │   ├── ui/                   # Radix UI primitives (shadcn/ui patterns)
│   │   ├── shared/               # Header, ResponseViewer, KeyValueEditor, CodeEditor, etc.
│   │   └── providers/            # PlatformProvider, ThemeProvider
│   │
│   ├── routes/                   # React Router route components (index, not-found)
│   ├── store/                    # Zustand store re-exports
│   └── lib/shared/               # utils, encryption, storage, platform, validations, lazyComponent
│
├── worker/                       # Cloudflare Pages Function (web only)
│   ├── index.ts                  # Hono app — route mounting, CORS
│   ├── handlers/
│   │   ├── proxy.ts              # HTTP proxy handler
│   │   ├── grpc.ts               # gRPC handler
│   │   ├── grpc-reflection.ts    # gRPC reflection handler
│   │   └── mcp.ts                # MCP handler
│   ├── shared/
│   │   ├── url-validation.ts     # SSRF guards
│   │   └── grpc-status.ts        # gRPC status code enum
│   └── tsconfig.json
│
├── electron/
│   └── main/                     # Main process
│       ├── main.ts               # App entry — orchestrates modules
│       ├── window-manager.ts     # Window creation; loads SPA
│       ├── preload.ts            # Secure IPC bridge (context-isolated)
│       ├── http-handler.ts       # Native HTTP (replaces Worker on desktop)
│       ├── grpc-handler.ts       # Native gRPC
│       ├── grpc-reflection-handler.ts
│       ├── websocket-handler.ts  # Native WebSocket
│       ├── sse-handler.ts        # Native SSE
│       ├── mcp-handler.ts        # Native MCP
│       ├── file-operations.ts    # Native file system access
│       ├── collection-manager.ts # Collection storage via electron-store
│       ├── store-handler.ts      # Persistent store bridge
│       ├── auto-updater.ts       # electron-updater integration
│       ├── menu.ts               # Application menu
│       ├── system-tray.ts        # System tray icon
│       ├── notifications.ts      # OS notifications
│       ├── ipc-validators.ts     # IPC input validation
│       ├── ipc-rate-limiter.ts   # IPC rate limiting
│       ├── interceptor-registry.ts
│       ├── request-logger.ts
│       └── deep-link-handler.ts
│
├── tests/                        # Shared test fixtures and setup
│   └── setup.ts
│
├── scripts/                      # Build utilities
│   └── generate-icons.js
│
├── docs/                         # Project documentation
├── public/                       # Static assets
│
└── [root configs]
    ├── vite.config.mts           # Vite config (ESM, @cloudflare/vite-plugin)
    ├── wrangler.jsonc            # Cloudflare Worker config
    ├── electron-builder.json     # Electron packaging config
    ├── tsconfig.json             # Renderer TypeScript config
    ├── tsconfig.base.json        # Shared TS base
    ├── tailwind.config.ts        # Tailwind v4 config
    ├── vitest.config.ts          # Test config
    └── eslint.config.mjs         # ESLint flat config
```

---

## Renderer Architecture

### Component Organization

```
┌─────────────────────────────────────────────────────────────┐
│                         App Layout                          │
├────────────┬────────────────────────────────────────────────┤
│  Sidebar   │               Main Content                     │
│            ├────────────────────────────────────────────────┤
│ Collections│            Header / Protocol Tabs              │
│ History    ├────────────────────────────────────────────────┤
│ Workflows  │           Request Builder                      │
│            │  ┌─────────────────────────────────────────┐  │
│            │  │  Method + URL bar                       │  │
│            │  ├─────────────────────────────────────────┤  │
│            │  │  Tabs: Params · Headers · Body · Auth   │  │
│            │  │         Scripts · Pre-request           │  │
│            │  └─────────────────────────────────────────┘  │
│            ├────────────────────────────────────────────────┤
│            │           Response Viewer                      │
│            │  ┌─────────────────────────────────────────┐  │
│            │  │  Status · Duration · Size               │  │
│            │  ├─────────────────────────────────────────┤  │
│            │  │  Body (Monaco Editor) · Headers ·       │  │
│            │  │  Cookies · Test Results                 │  │
│            │  └─────────────────────────────────────────┘  │
└────────────┴────────────────────────────────────────────────┘
```

### Routing

`createHashRouter` is used so that the same renderer HTML works under both `https://` (Cloudflare Pages) and `file://` (Electron). There is no server-side routing; React Router handles everything client-side.

### State Management

All global state lives in Zustand stores with `persist` middleware (localStorage). Stores are validated with Zod schemas in `src/lib/shared/store-validators.ts`.

```
┌───────────────────────────────────────────────────────────────┐
│                          Zustand Stores                       │
├──────────────┬──────────────┬──────────────┬──────────────────┤
│ useRequest   │ useCollection│ useEnviron-  │ useHistory       │
│ Store        │ Store        │ mentStore    │ Store            │
├──────────────┼──────────────┼──────────────┼──────────────────┤
│ url          │ collections  │ environments │ entries          │
│ method       │ folders      │ activeEnv    │ favorites        │
│ headers      │ CRUD ops     │ variables    │ limit            │
│ body         │              │ CRUD ops     │                  │
│ auth         │              │              │                  │
├──────────────┴──────────────┴──────────────┴──────────────────┤
│ useSettings  │ useWorkflow  │                                  │
│ Store        │ Store        │                                  │
├──────────────┼──────────────┤                                  │
│ theme        │ workflows    │                                  │
│ preferences  │ executions   │                                  │
└──────────────┴──────────────┴──────────────────────────────────┘
                          │
                          ▼
                   localStorage (persist)
```

### Protocol Transport Abstraction

The renderer detects its runtime environment via `isElectron()` (checks for `window.electronAPI`):

```
requestExecutor.ts
  isElectron() → window.electronAPI.sendHttpRequest(...)   // IPC
              → fetch('/api/proxy', ...)                   // Worker

grpcClient.ts
  isElectron() → window.electronAPI.sendGrpcRequest(...)   // IPC
              → fetch('/api/grpc', ...)                    // Worker
```

This branching is identical for WebSocket, SSE, and MCP clients, so the renderer is behaviorally identical regardless of delivery target.

### Lazy Components

`next/dynamic` is not used. The project uses `src/lib/shared/lazyComponent.tsx` — a thin wrapper around `React.lazy` + `Suspense` that mirrors `next/dynamic` ergonomics. Monaco Editor and other heavy dependencies are lazy-loaded this way.

---

## Cloudflare Worker (Web Only)

The Worker is a Hono application deployed as a Cloudflare Pages Function (`_worker.js`).

### Key Facts

- Bundled into `dist/web/_worker.js` by `@cloudflare/vite-plugin` during `vite build`
- Excluded from the Electron build (`VITE_IS_ELECTRON_BUILD=true` skips the Cloudflare plugin)
- Compatibility flags: `nodejs_compat`, `cloudflare_sockets_api`
- SSRF protection: `worker/shared/url-validation.ts` blocks private/loopback IPs in production; the `ENVIRONMENT` var gates `allowLocalhost`

### Route Map

| Route | Handler | Purpose |
|---|---|---|
| `POST /api/proxy` | `proxy.ts` | HTTP/HTTPS request proxying |
| `POST /api/grpc` | `grpc.ts` | gRPC unary + streaming |
| `POST /api/grpc/reflection` | `grpc-reflection.ts` | gRPC server reflection |
| `POST /api/mcp` | `mcp.ts` | MCP server proxy |

---

## Electron Architecture

### Main Process Modules

```
main.ts (entry)
  ├── window-manager.ts      # Creates BrowserWindow
  │     ├── dev:  http://localhost:5173
  │     └── prod: dist/web/index.html (file://)
  ├── preload.ts             # contextBridge — exposes electronAPI to renderer
  ├── http-handler.ts        # IPC: native HTTP via axios
  ├── grpc-handler.ts        # IPC: native gRPC via @grpc/grpc-js
  ├── websocket-handler.ts   # IPC: native WebSocket via ws
  ├── sse-handler.ts         # IPC: native SSE via EventSource
  ├── mcp-handler.ts         # IPC: native MCP
  ├── file-operations.ts     # IPC: native file read/write/dialog
  ├── collection-manager.ts  # IPC: electron-store backed collections
  ├── auto-updater.ts        # electron-updater (GitHub releases)
  ├── menu.ts                # Application menu (macOS menu bar, Windows/Linux)
  ├── system-tray.ts         # Tray icon + context menu
  ├── ipc-validators.ts      # Zod validation for all IPC payloads
  └── ipc-rate-limiter.ts    # Rate limiting for IPC calls
```

### IPC Security

- Context isolation is enabled; the renderer cannot access Node.js APIs directly
- All IPC inputs are validated with Zod schemas in `ipc-validators.ts` before processing
- IPC calls are rate-limited in `ipc-rate-limiter.ts`
- `preload.ts` exposes only the explicitly declared `electronAPI` surface via `contextBridge`

### Build Process

1. `electron:build:web` — `vite build` with `VITE_IS_ELECTRON_BUILD=true` → `dist/web/`
2. `electron:compile` — `tsc -p electron/tsconfig.json` → `dist/electron/`
3. `electron-builder` — packages `dist/web/` + `dist/electron/` into installable artifacts

---

## Supported Protocols

| Protocol | Web (Worker) | Desktop (IPC) |
|---|---|---|
| HTTP/HTTPS | `/api/proxy` | `http-handler.ts` |
| gRPC unary | `/api/grpc` | `grpc-handler.ts` |
| gRPC streaming | `/api/grpc` | `grpc-handler.ts` |
| gRPC reflection | `/api/grpc/reflection` | `grpc-reflection-handler.ts` |
| WebSocket | Browser native | `websocket-handler.ts` |
| Server-Sent Events | Browser native | `sse-handler.ts` |
| GraphQL (over HTTP) | `/api/proxy` | `http-handler.ts` |
| MCP | `/api/mcp` | `mcp-handler.ts` |

---

## Security

### SSRF Prevention

`worker/shared/url-validation.ts` rejects requests to private IP ranges (RFC 1918), loopback, and link-local addresses in the production Worker. The `ENVIRONMENT=development` var in `.dev.vars` enables localhost proxying for local development.

### Electron Hardening

- Hardened runtime enabled (macOS notarization)
- Context isolation prevents renderer from accessing Node.js
- IPC payloads validated with Zod before any processing
- Rate limiting on all IPC handlers
- `webSecurity` is not disabled

### Script Sandboxing

Pre-request and test scripts run inside a QuickJS WASM instance (`quickjs-emscripten`). They cannot access the DOM, make network requests, or escape the sandbox.

### Input Validation

All stores are validated with Zod schemas on hydration from localStorage (`src/lib/shared/store-validators.ts`).

---

## Testing

Tests are colocated with source files as `*.test.ts` / `*.test.tsx`. Vitest runs in jsdom environment with React Testing Library. Setup file: `tests/setup.ts`.

### Type-Check Coverage

CI type-checks three independent TypeScript projects:
1. Renderer — `tsc --noEmit` (uses `tsconfig.json`)
2. Electron main — `tsc --noEmit -p electron/tsconfig.json`
3. Worker — `tsc --noEmit -p worker/tsconfig.json`

---

## Deployment

### Web (Cloudflare Pages)

- CI builds with `npm run build` → `vite build`
- `@cloudflare/vite-plugin` bundles the Hono Worker into `dist/web/_worker.js`
- Cloudflare Pages serves the SPA and routes `api/*` to the Worker function
- Production: `wrangler pages deploy dist/web --project-name=restura --branch=main`
- Previews: auto-deployed on each PR, URL commented on the PR

### Desktop

- `electron-builder` packages `dist/web/` (renderer) and `dist/electron/` (main process)
- Releases published to GitHub via `electron-updater`
- macOS: notarized DMG + ZIP (x64 + arm64)
- Windows: NSIS installer + portable (x64 + ia32)
- Linux: AppImage + deb + rpm (x64)

---

## Development Principles

1. **Type safety**: Strict TypeScript across renderer, Worker, and Electron main process — three separate `tsconfig.json` files, all strict
2. **Feature co-location**: Each feature owns its components, hooks, stores, and tests in `src/features/<name>/`
3. **No server-side rendering**: Pure SPA with hash routing for portability across `https://` and `file://`
4. **Zero Worker in desktop**: The Electron build excludes `_worker.js` entirely; no Cloudflare runtime in the desktop app
5. **Zod at boundaries**: All external inputs (localStorage hydration, IPC payloads, API responses) are validated with Zod schemas
6. **Sandbox scripts**: User-provided scripts never run in the browser's JavaScript context
