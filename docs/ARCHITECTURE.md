# Restura — Architecture

## Overview

Restura is a multi-protocol API testing client that ships to three targets from one codebase: a **web application** (Cloudflare Pages + Workers), a **self-hostable Node/Docker server**, and an **Electron desktop app**. The same Vite-built React SPA is the renderer for all three; only the transport layer differs (chosen at runtime by `isElectron()`). The two HTTP backends — the Cloudflare Worker and the Node/Docker server — share a single Hono app via the `createApp(deps)` factory (see ADR 0009).

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Browser / Desktop                       │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │          React SPA (shared renderer)                    │   │
│   │  Vite 8 · React 19 · React Router v7 (hash) · Zustand  │   │
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

SSRF guards in `shared/protocol/url-validation.ts` block private/localhost URLs in production. See [Shared Protocol Layer](#shared-protocol-layer) below — the same guard runs on the desktop side.

### Electron path

```
User → Vite SPA → window.electron (preload IPC) → main process handlers → Target API
```

The Electron main process exposes native handlers via a secure context-isolated preload script. No Worker is bundled; the desktop app uses Node.js APIs directly for all protocols.

---

## Shared Protocol Layer

### Goal

Each protocol (HTTP, gRPC, MCP, WebSocket, SSE, AI) is implemented **once** in `shared/protocol/`, not per-backend. The Worker, the Node/Docker server, and the Electron main process each supply only the transport: they call into the same orchestrator with the same validation rules, the same body builders, the same header sanitisers, and the same response shape. Before this refactor each protocol was duplicated across the backends and the copies had already drifted (notably the SSRF guard). The browser-capture extension reuses the same pattern via `shared/capture/` (see ADR 0024).

### Layout

```
shared/protocol/
  ├── types.ts              ── RequestSpec, Fetcher, ExecuteResult discriminated union
  ├── url-validation.ts     ── SSRF guard (single source of truth)
  ├── header-policy.ts      ── Hop-by-hop deny lists + sanitisers
  ├── body-builder.ts       ── JSON / text / form-urlencoded / form-data / binary
  ├── http-proxy.ts         ── executeHttpProxy(spec, fetcher, options)
  ├── grpc-proxy.ts         ── executeGrpcProxy(spec, fetcher, options)
  ├── grpc-status.ts        ── gRPC status code enum + reverse map
  ├── grpc-registry.ts      ── runtime protobuf descriptor registry (ADR 0022)
  ├── mcp-proxy.ts          ── validateMcpSpec(spec, allowLocalhost)
  ├── websocket-proxy.ts    ── executeWebSocketProxy(spec, fetcher, options)
  ├── sse-parser.ts         ── canonical W3C SSE event-frame parser
  ├── ndjson-parser.ts      ── line-delimited JSON parser
  ├── auth-signer.ts        ── wire-level auth signing (SigV4 etc.)
  ├── oauth1-signer.ts      ── OAuth 1.0 signing
  ├── wsse-header.ts        ── WSSE header construction
  ├── secret-value-schema.ts── SecretRef handle schema (ADR 0007)
  ├── crypto-utils.ts       ── shared crypto helpers
  └── ai/                   ── provider-agnostic AI chat orchestrator (ADR 0010)
```

The browser-capture extension's pipeline lives in a sibling module, `shared/capture/` (normalizer, classifier, secret-extractor, HAR / OpenCollection exporters — ADR 0024).

| Module                              | Responsibility                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `shared/protocol/url-validation.ts` | SSRF guard: blocks RFC 1918, RFC 6598 (CGNAT), link-local, loopback, and cloud-metadata endpoints; DNS-rebind check |
| `shared/protocol/header-policy.ts`  | Hop-by-hop deny lists + header sanitisers                                                                           |
| `shared/protocol/body-builder.ts`   | JSON / text / form-urlencoded / form-data / binary body construction                                                |
| `shared/protocol/types.ts`          | `RequestSpec`, `Fetcher`, `ExecuteResult` discriminated union                                                       |
| `shared/protocol/http-proxy.ts`     | `executeHttpProxy(spec, fetcher, options)` — HTTP orchestrator + `MAX_RESPONSE_SIZE` cap                            |
| `shared/protocol/grpc-proxy.ts`     | `executeGrpcProxy(spec, fetcher, options)` — Connect-protocol orchestrator                                          |
| `shared/protocol/grpc-status.ts`    | gRPC status code enum + reverse map                                                                                 |
| `shared/protocol/mcp-proxy.ts`      | `validateMcpSpec(spec, allowLocalhost)` — JSON-RPC envelope + URL validation                                        |

### Backend adapters

Each backend supplies a `Fetcher` — `(req: FetcherRequest) => Promise<FetcherResponse>` — that performs the actual transport call given a normalised request, returning a normalised response. The shared core is invoked the same way in both places:

```
              ┌──────────────────────────────────────────┐
              │     shared/protocol/{http,grpc,mcp}      │
              │     (validation, body, headers, shape)   │
              └────────────────┬─────────────────────────┘
                               │ Fetcher
              ┌────────────────┴─────────────────┐
              ▼                                  ▼
   worker/handlers/*.ts                electron/main/handlers/http-handler.ts
   (globalThis.fetch)                  (Node http/https via undici)
```

- **Cloudflare Worker** — `worker/handlers/*.ts` wrap `globalThis.fetch`. The Hono app itself is built by `createApp(deps)` in `worker/app.ts`; `worker/index.ts` composes it with Cloudflare adapters. Worker-only feature: upstream-proxy via the Cloudflare Sockets API in `worker/shared/tcp-proxy.ts`.
- **Self-hosted Node/Docker server** — `worker/node-entry.ts` runs the same `createApp` in a single Node process that serves both the SPA and `/api/*`. Node-native adapters live in `worker/shared/tcp-proxy-node.ts`, `worker/shared/dns-guard-node.ts`, and `worker/handlers/websocket-node.ts` (see ADR 0009 and `docs/SELF_HOSTING.md`).
- **Electron main process** — `electron/main/handlers/http-handler.ts` wraps Node's `http`/`https` (via undici). Electron-only features (PAC resolution, SOCKS4/5 tunnel, mTLS, CA cert, interceptor registry, manual redirect handling, connect-time DNS-rebind pinning for HTTP/gRPC/WebSocket/SSE via `Agent.connect.lookup` + `electron/main/security/safe-connect.ts`, and a pre-flight DNS guard via `electron/main/security/dns-guard.ts` for the remaining transports) live inside the Electron fetcher closures — **not** in shared. The shared core stays backend-agnostic. Long-lived streaming handlers (`grpc-handler.ts`, `mcp-handler.ts`, `sse-handler.ts`, `websocket-handler.ts`, `socketio-handler.ts`, `kafka-handler.ts`, `mqtt-handler.ts`) share connection bookkeeping via `electron/main/ipc/stream-registry.ts` and `electron/main/ipc/connection-cleanup.ts` (`bindRendererCleanup`, `disposeByOwner`) — see ADR-0006.

### Adding a new protocol

1. Add a `shared/protocol/<name>-proxy.ts` module exposing an `execute<Name>Proxy(spec, fetcher, options)` orchestrator that returns `ExecuteResult`.
2. Add a Worker handler (~30 lines) that builds a `Fetcher` over `globalThis.fetch` and forwards the result.
3. Add an Electron handler (~30 lines) that builds a `Fetcher` over Node `http`/`https` (or whatever transport the protocol needs) and forwards the result.

SSRF rules, header sanitisers, body construction, error mapping, and timeouts come for free.

---

## Technology Stack

| Concern          | Technology                                                                    |
| ---------------- | ----------------------------------------------------------------------------- |
| Build tool       | Vite 8 + `@cloudflare/vite-plugin`                                            |
| UI framework     | React 19                                                                      |
| Routing          | React Router v7 (`createHashRouter`)                                          |
| Styling          | TailwindCSS v4 via `@tailwindcss/vite`                                        |
| UI components    | shadcn/ui patterns on Radix UI primitives                                     |
| State management | Zustand v5 with `persist` middleware                                          |
| Validation       | Zod v4                                                                        |
| Code editor      | Monaco Editor (`@monaco-editor/react`)                                        |
| Script sandbox   | QuickJS WASM (`quickjs-emscripten`)                                           |
| gRPC (web)       | `@connectrpc/connect-web` + `@bufbuild/protobuf`                              |
| gRPC (desktop)   | `@connectrpc/connect-node` + `@bufbuild/protobuf` (ADR 0022; grpc-js removed) |
| Worker framework | Hono                                                                          |
| Desktop shell    | Electron 42                                                                   |
| Auto-updates     | `electron-updater`                                                            |
| Testing          | Vitest + React Testing Library                                                |
| Deployment       | Cloudflare Pages + Functions                                                  |

---

## Project Structure

```
restura/
│
├── src/                          # Renderer source (shared by web and desktop)
│   ├── features/                 # Feature modules (co-located components, hooks, stores)
│   │   ├── http/                 # HTTP/REST: RequestBuilder, requestExecutor, useHttpRequest, useCookieStore
│   │   ├── grpc/                 # gRPC: GrpcRequestBuilder, grpcClient, grpcReflection
│   │   ├── graphql/              # GraphQL: GraphQLRequestBuilder, GraphQLBodyEditor, SchemaExplorer
│   │   ├── websocket/            # WebSocket: WebSocketClient
│   │   ├── socketio/             # Socket.IO client
│   │   ├── sse/                  # Server-Sent Events client
│   │   ├── kafka/                # Kafka producer/consumer (desktop only)
│   │   ├── mqtt/                 # MQTT client (desktop only)
│   │   ├── mcp/                  # Model Context Protocol client
│   │   ├── ai/                   # AI assistant (chat + request-context tooling)
│   │   ├── ai-lab/               # Electron-only LLM/prompt eval workbench
│   │   ├── mcp-server/           # Restura-as-MCP-server surface
│   │   ├── load-testing/         # Collection load/perf runner
│   │   ├── workflows/            # Request chaining, variable extraction, retry policies
│   │   ├── collections/          # Sidebar, CollectionRunner, importers, exporters
│   │   ├── environments/         # EnvironmentManager
│   │   ├── registry/             # Service/schema registry
│   │   ├── contracts/            # OpenAPI contract testing
│   │   ├── auth/                 # AuthConfig (shared across protocols)
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
├── shared/                       # Backend-agnostic cores (used by Worker + Node + Electron)
│   ├── protocol/                 # Protocol orchestrators (see Layout above for the full module list)
│   │   ├── url-validation.ts     # SSRF guards (single source of truth)
│   │   ├── http-proxy.ts         # executeHttpProxy(spec, fetcher, options)
│   │   ├── grpc-proxy.ts         # executeGrpcProxy + grpc-registry, grpc-status
│   │   ├── websocket-proxy.ts    # executeWebSocketProxy
│   │   ├── mcp-proxy.ts          # validateMcpSpec(spec, allowLocalhost)
│   │   ├── sse-parser.ts         # SSE / ndjson stream parsers
│   │   ├── auth-signer.ts        # wire-level auth (SigV4, OAuth1, WSSE)
│   │   └── ai/                   # provider-agnostic AI chat orchestrator
│   └── capture/                  # Browser-capture pipeline (ADR 0024): normalizer, classifier,
│                                 #   secret-extractor, to-har, to-opencollection
│
├── worker/                       # Shared Hono app — Cloudflare Worker + self-hosted Node
│   ├── app.ts                    # createApp(deps) — the shared Hono app factory (ADR 0009)
│   ├── index.ts                  # Cloudflare entry — composes createApp with CF adapters
│   ├── node-entry.ts             # Self-hosted Node/Docker entry (SPA + /api/* on one port)
│   ├── handlers/                 # Thin Fetcher adapters → shared/protocol orchestrators
│   ├── middleware/               # rateLimiter, auth gate
│   ├── shared/                   # tcp-proxy (CF Sockets) + tcp-proxy-node / dns-guard-node
│   └── tsconfig.json
│
├── electron/
│   └── main/                     # Main process — organised into purpose-based subfolders
│       ├── main.ts               # Entry / orchestrator (IPC_MODULES registry)
│       ├── window-manager.ts     # Window creation; loads SPA (__dirname-sensitive — stays at root)
│       ├── preload.ts            # Secure IPC bridge (context-isolated)
│       ├── notifications.ts      # OS notifications
│       ├── handlers/             # One per protocol/concern: http, grpc, websocket, socketio,
│       │                         #   sse, mcp, kafka, mqtt, ai, ai-lab, mcp-server,
│       │                         #   mock-server, git, capture-bridge
│       ├── ipc/                  # IPC boundary: ipc-validators, ipc-rate-limiter,
│       │                         #   stream-registry, connection-cleanup
│       ├── security/             # dns-guard, safe-connect, broker guards, secret-handle-store
│       ├── storage/              # store-handler, collection-manager, vault, file-operations
│       ├── lifecycle/            # request-logger, auto-updater, menu, system-tray, deep-link, sentry
│       └── util/                 # small shared helpers
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

All global state lives in Zustand stores with `persist` middleware. Stores are validated with Zod schemas in `src/lib/shared/store-validators.ts`. Persistence goes through `src/lib/shared/dexie-storage.ts` (web — IndexedDB via Dexie) or `src/lib/shared/secure-storage.ts` (Electron — encrypted electron-store via IPC). The legacy `src/lib/shared/storage.ts` localStorage adapter has been removed.

```
┌───────────────────────────────────────────────────────────────┐
│                          Zustand Stores                       │
├──────────────┬──────────────┬──────────────┬──────────────────┤
│ useRequest   │ useCollection│ useEnviron-  │ useHistory       │
│ Store        │ Store        │ mentStore    │ Store            │
├──────────────┼──────────────┼──────────────┼──────────────────┤
│ tabs[]       │ collections  │ environments │ entries          │
│ activeTabId  │ folders      │ activeEnv    │ favorites        │
│ (tab-based,  │ CRUD ops     │ variables    │ limit            │
│ see below)   │              │ CRUD ops     │                  │
├──────────────┴──────────────┴──────────────┴──────────────────┤
│ useSettings  │ useWorkflow  │                                  │
│ Store        │ Store        │                                  │
├──────────────┼──────────────┤                                  │
│ theme        │ workflows    │                                  │
│ preferences  │ executions   │                                  │
└──────────────┴──────────────┴──────────────────────────────────┘
                          │
                          ▼
            Dexie (web) / electron-store (desktop)
```

### Multi-tab request model

The renderer holds open requests as tabs in `useRequestStore`:

- `tabs: RequestTab[]` — each tab has `{ id, request, response?, scriptResult?, isDirty, savedRequestId? }`
- `activeTabId: string | null` — currently focused tab

The page-level request mode is derived from the active tab's `request.type` — there is no separate "current protocol" state. Tabs persist to Dexie (`requestTabs` table, schema v2) so refresh/restart preserves the open set, including the last response per tab.

Saved requests opened from the sidebar focus an existing matching tab (by `savedRequestId`) before opening a new one. The `TabBar` component (`src/components/shared/TabBar.tsx`) renders the tab strip; tab actions go through `useRequestStore` (`openTab`, `closeTab`, `switchTab`, `duplicateTab`, `reorderTabs`, `closeOtherTabs`, `closeAllTabs`, `createNewRequest`).

Editor state (cursor, undo, fold) is preserved per tab via Monaco's `path` prop — each tab's editor uses `path="tab-<id>-<role>"` (where role ∈ `body | response | grpc-message | graphql-query | graphql-variables`), so Monaco automatically maintains a separate `ITextModel` per path.

Selectors at `src/store/selectors.ts` expose tab-aware hooks: `useActiveTab()`, `useActiveRequest('http' | 'grpc' | 'sse' | 'mcp')`, `useActiveResponse()`. Consumers should prefer these over destructuring the whole store, since they re-render only when the relevant tab subset changes.

### Streaming and HTTP/2

Restura streams `text/event-stream`, `application/x-ndjson`, and `application/jsonl` responses end-to-end instead of buffering. The shared protocol layer (Plan 1) was extended in Plan 4 with:

- `executeHttpProxyStreaming(spec, fetcher, options)` returns a `StreamingResponseHandle` whose `body: ReadableStream<Uint8Array>` is handed to the caller without buffering. Does NOT enforce `MAX_RESPONSE_SIZE` — streaming is unbounded by intent.
- `shared/protocol/sse-parser.ts` — canonical W3C SSE event-frame parser (consumed by worker MCP, Electron SSE, and renderer SSE)
- `shared/protocol/ndjson-parser.ts` — line-delimited JSON parser with `__parseError` sentinel for malformed lines
- `FetcherResponse.body?: ReadableStream<Uint8Array>` — optional streaming-mode field on the Fetcher contract; populated by Worker (native fetch) and Electron (undici)

**Worker path:** When the request has `Accept: text/event-stream | application/x-ndjson | application/jsonl` (or `streamingMode: true`), `worker/handlers/proxy.ts` routes through `executeHttpProxyStreaming` and pipes the upstream body via Hono's `stream(c, ...)` helper. Otherwise the buffered path runs unchanged.

**Renderer:** `src/features/http/lib/streamingResponseReader.ts` consumes a `Response` as an `AsyncIterable<StreamEvent>` (sse | ndjson | raw + terminating end/error). The new `StreamingResponseViewer` (`src/components/shared/StreamingResponseViewer.tsx`) renders events incrementally via a tiny windowed-list helper (no `react-window` dep) with auto-scroll, pause/resume, and a "Jump to latest" pill.

**Electron HTTP:** Migrated from `node:http`/`https` to `undici.request`. undici negotiates ALPN automatically, exposes `negotiatedProtocol` for HTTP/2 detection, and gives us streaming response bodies via `Readable.toWeb`. All Plan 1 features preserved: PAC resolution, HTTP/HTTPS proxy via `ProxyAgent`, SOCKS4/5 via custom `Agent` with the pre-established socket, mTLS / CA via `Agent.connect`, DNS-rebind guard via `Agent.connect.lookup`, manual redirect handling at the wrapper level.

**gRPC streaming:** The renderer ships server-streaming via `src/features/grpc/lib/grpcStreamingClient.ts`, which sends Connect-protocol envelopes (1-byte flags + 4-byte big-endian length + JSON payload) directly to the upstream and parses the streaming response framing. This bypasses the worker — Connect-Web speaks HTTP/2 to the upstream when CORS permits. Client-streaming and bidirectional-streaming throw with a clear "not yet implemented" message; UI for those is a follow-up.

**ALPN indicator:** `Response.negotiatedAlpn` is populated by the Electron path (undici exposes it) and surfaces as a small "HTTP/2" / "HTTP/1.1" badge in the response metadata bar. Worker path leaves it undefined (CF runtime doesn't expose ALPN).

### Web vs Desktop feature parity

Some Restura features depend on capabilities the browser doesn't expose. They're available in the Electron desktop app but hidden / disabled in the web client:

- **mTLS** (client certificates): browsers don't allow JavaScript to present a client certificate. Electron uses Node TLS via undici.
- **Custom CA certificates**: same restriction — the browser uses the system trust store and doesn't let pages override it. Electron honours a user-supplied PEM via undici's `Agent.connect.ca`.
- **SOCKS proxies** (SOCKS4 / SOCKS5): browsers can't open raw TCP. Electron tunnels via Node `net` and a custom undici dispatcher.
- **PAC files** (Proxy Auto-Config): **not wired end-to-end** — the renderer `ProxyType` cannot emit a PAC proxy and the PAC script is never loaded via `session.setProxy()`. Marked `❌ / ❌` in the capability matrix; tracked as future work.
- **System proxy detection**: Electron reads OS proxy settings; browsers only honour what the OS configures globally and don't let pages introspect.
- **"Verify SSL = off"**: browsers always validate TLS regardless of any app toggle. Only Electron can opt out (`rejectUnauthorized: false`) for self-signed dev certificates.
- **Hardware-backed encryption**: Electron uses `safeStorage` (macOS Keychain, Windows Credential Manager, Linux libsecret); web defaults to in-memory ephemeral encryption per session.

The web client surfaces a "Desktop only" badge (`src/components/shared/DesktopOnlyBadge.tsx`) on UI fields that depend on these capabilities, with a tooltip explaining the difference. Inside Electron the badge renders nothing.

### Protocol Transport Abstraction

The renderer detects its runtime environment via `isElectron()` (checks for `window.electron`):

```
requestExecutor.ts
  isElectron() → window.electron.http.request(...)         // IPC
              → fetch('/api/proxy', ...)                   // Worker

grpcClient.ts
  isElectron() → window.electron.grpc.request(...)         // IPC
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
- Compatibility flag: `nodejs_compat`
- SSRF protection: `shared/protocol/url-validation.ts` blocks private/loopback IPs in production; the `ENVIRONMENT` var gates `allowLocalhost`. The same module runs on the Electron side — see [Shared Protocol Layer](#shared-protocol-layer)

### Route Map

| Route                       | Handler              | Purpose                     |
| --------------------------- | -------------------- | --------------------------- |
| `POST /api/proxy`           | `proxy.ts`           | HTTP/HTTPS request proxying |
| `POST /api/grpc`            | `grpc.ts`            | gRPC unary + streaming      |
| `POST /api/grpc/reflection` | `grpc-reflection.ts` | gRPC server reflection      |
| `POST /api/mcp`             | `mcp.ts`             | MCP server proxy            |

---

## Electron Architecture

### Main Process Modules

Files that compute `__dirname`-relative paths at runtime (`main.ts`, `window-manager.ts`, `preload.ts`, `notifications.ts`) stay at the `electron/main/` root; everything else is grouped into purpose-based subfolders.

```
main.ts (entry — owns the IPC_MODULES register/dispose registry)
  ├── window-manager.ts          # Creates BrowserWindow
  │     ├── dev:  http://localhost:5173
  │     └── prod: dist/web/index.html (file://)
  ├── preload.ts                 # contextBridge — exposes window.electron to renderer
  ├── handlers/                  # One handler per protocol/concern
  │     ├── http-handler.ts      # IPC: native HTTP via undici
  │     ├── grpc-handler.ts      # IPC: native gRPC via @connectrpc/connect-node
  │     ├── grpc-reflection-handler.ts
  │     ├── websocket-handler.ts # IPC: native WebSocket via ws
  │     ├── socketio-handler.ts  # IPC: native Socket.IO
  │     ├── sse-handler.ts       # IPC: native SSE
  │     ├── mcp-handler.ts       # IPC: native MCP
  │     ├── kafka-handler.ts     # IPC: Kafka producer/consumer
  │     ├── mqtt-handler.ts      # IPC: MQTT pub/sub
  │     ├── ai-handler.ts        # IPC: AI chat streaming
  │     ├── ai-lab-handler.ts    # IPC: AI Lab eval/complete
  │     ├── mcp-server-handler.ts# IPC: Restura-as-MCP-server
  │     ├── mock-server-handler.ts
  │     ├── git-handler.ts
  │     └── capture-bridge-handler.ts  # 127.0.0.1 capture receiver (ADR 0024)
  ├── ipc/                       # IPC boundary
  │     ├── ipc-validators.ts    # Zod validation for all IPC payloads
  │     ├── ipc-rate-limiter.ts  # Rate limiting for IPC calls
  │     ├── stream-registry.ts   # Shared streaming-connection bookkeeping
  │     └── connection-cleanup.ts# Idempotent renderer-destroyed cleanup
  ├── security/                  # dns-guard, safe-connect, broker guards, secret-handle-store
  ├── storage/                   # store-handler, collection-manager, vault, file-operations
  └── lifecycle/                 # request-logger, auto-updater, menu, system-tray, deep-link, sentry
```

### IPC Security

- Context isolation is enabled; the renderer cannot access Node.js APIs directly
- All IPC inputs are validated with Zod schemas in `ipc/ipc-validators.ts` before processing
- IPC calls are rate-limited in `ipc/ipc-rate-limiter.ts`
- `preload.ts` exposes only the explicitly declared `window.electron` surface via `contextBridge`

### Build Process

1. `electron:build:web` — `vite build` with `VITE_IS_ELECTRON_BUILD=true` → `dist/web/`
2. `electron:compile` — `tsc -p electron/tsconfig.json` → `dist/electron/`
3. `electron-builder` — packages `dist/web/` + `dist/electron/` into installable artifacts

---

## Supported Protocols

| Protocol            | Web (Worker)           | Desktop (IPC)                |
| ------------------- | ---------------------- | ---------------------------- |
| HTTP/HTTPS          | `/api/proxy`           | `http-handler.ts`            |
| gRPC unary          | `/api/grpc`            | `grpc-handler.ts`            |
| gRPC streaming      | `/api/grpc`            | `grpc-handler.ts`            |
| gRPC reflection     | `/api/grpc/reflection` | `grpc-reflection-handler.ts` |
| WebSocket           | `/api/ws` (+ ticket)   | `websocket-handler.ts`       |
| Socket.IO           | Browser native         | `socketio-handler.ts`        |
| Server-Sent Events  | Browser native         | `sse-handler.ts`             |
| GraphQL (over HTTP) | `/api/proxy`           | `http-handler.ts`            |
| Kafka               | ❌ (no browser TCP)    | `kafka-handler.ts`           |
| MQTT                | ❌ (no browser TCP)    | `mqtt-handler.ts`            |
| MCP                 | `/api/mcp`             | `mcp-handler.ts`             |
| AI assistant        | ❌ (no Worker route)   | `ai-handler.ts`              |
| AI Lab              | ❌ (desktop only)      | `ai-lab-handler.ts`          |

---

## Collection format

Restura speaks **OpenCollection v1.0.0** natively (the format Bruno 3.1+ uses). Implementation lives at [`src/lib/opencollection/`](../src/lib/opencollection/) — vendored JSON Schema, generated TS types, Zod runtime validators, YAML serializer, fs reader/writer, and bidirectional bridges to the internal `Collection` model. SSE and MCP requests live under the spec's `extensions` field as `x-restura-sse` / `x-restura-mcp` (round-trip stable).

A legacy `.http.yaml`/`.grpc.yaml`/`.sse.yaml`/`.mcp.yaml` per-request format also exists at `src/lib/shared/file-collection-schema.ts` and is still used by the CLI runner and the existing Electron file watcher; it's marked `@deprecated` and migration to OpenCollection is tracked in the Phase 1/3 roadmap. See [`docs/opencollection.md`](./opencollection.md) for the user-facing format guide.

---

## Security model

Restura's security posture is asymmetric between the Electron desktop client and the Web/PWA client by virtue of platform capability gaps. See [Web vs Desktop feature parity](#web-vs-desktop-feature-parity) for the user-visible side; this section covers the implementation.

### Encryption keys

The `KeyProvider` interface (`src/lib/shared/keyProvider.ts`) abstracts where the encryption key for the renderer's Dexie store comes from:

- **Electron**: `ElectronSafeStorageKeyProvider` persists the key via the existing `electronAPI.store` IPC, which is `safeStorage`-protected at the Electron main level (`electron/main/store-handler.ts`). The OS keychain holds the wrapping key — macOS Keychain, Windows Credential Manager, Linux libsecret.
- **Web**: `PlaintextKeyProvider` by default — IndexedDB is protected only by the browser's same-origin policy. `WebSessionPassphraseProvider` exists, but its passphrase UI has not shipped and is not advertised as an available capability.

### Auth-at-the-wire

Auth that requires byte-for-byte signature fidelity (currently AWS SigV4) signs INSIDE the shared protocol core (`shared/protocol/auth-signer.ts`), after body construction and before the fetcher call. `RequestSpec.auth: AuthConfig | undefined` is the contract; the renderer passes auth config through to the proxy/IPC layer instead of pre-signing. Other auth types (Bearer, Basic, API-key, OAuth2) are still applied client-side because they don't depend on the body.

### Sandbox

User pre-request/test scripts run in a QuickJS WASM sandbox (`src/features/scripts/lib/scriptExecutor.ts`) with a 64 MB memory limit and a 5 s execution-time limit for sync-only scripts (30 s when a host bridge — `pm.sendRequest`/`pm.vault`/`pm.cookies`/`rs.judge` — is in use, since a sub-request or keychain unwrap legitimately takes longer). No capability is ambient; each is an explicit, audited host bridge (no filesystem, no raw network). The previous source-level regex blocklist (`dangerousPatterns`) was deleted in Plan 3 — it provided no security (the sandbox is the boundary) but broke legitimate user code.

### Network — SSRF prevention

SSRF guards on the Worker, the Node/Docker server (`shared/protocol/url-validation.ts`), and the Electron path block RFC 1918, CGNAT (100.64.0.0/10), link-local (169.254.0.0/16), cloud metadata endpoints, IPv6 unique-local + link-local, and IPv4-mapped IPv6 addresses. **HTTP, gRPC, WebSocket, and SSE additionally pin the connect to the validated address** (closing the DNS-rebind window): HTTP via undici's `Agent.connect.lookup` (`createSecureLookup`); WebSocket/SSE via `createPinnedLookup` / `createPinnedFetch` (`electron/main/security/safe-connect.ts`); gRPC via `connect-node`'s `nodeOptions.lookup` (ADR 0022 replaced the old grpc-js IP-literal dial). The remaining transports (Socket.IO, MCP, gRPC reflection, Kafka, MQTT) use the **pre-flight** guard in `electron/main/security/dns-guard.ts`: `assertUrlHostnameSafe(url, ...)` resolves the hostname and applies `assertResolvedAddressAllowed` to every record before connect, but cannot pin — a TTL=0 rebind between resolve and connect is not mitigated for them. Kafka and MQTT broker addresses additionally go through `kafka-broker-guard.ts` / `mqtt-broker-guard.ts`. Tracked as future work in ADR-0006.

The `ENVIRONMENT=development` var in `.dev.vars` enables localhost proxying for local development on the Worker; the Electron path receives the same `allowLocalhost` flag through the fetcher options.

### Validation

`useRequestStore.updateRequest` hard-fails on validator rejection. Invalid updates are not applied; the user sees a `toast.error` with the validation message.

All stores are validated with Zod schemas on hydration from persisted storage — Dexie (web) or electron-store (desktop) — via `src/lib/shared/store-validators.ts`.

### Electron hardening

- Hardened runtime enabled (macOS notarization)
- Context isolation prevents renderer from accessing Node.js
- IPC payloads validated with Zod before any processing (including the recursive `AuthConfigSchema` introduced in Plan 3 for sign-at-wire)
- Rate limiting on all IPC handlers via per-handler keyed limiters (`createKeyedRateLimiter` in `electron/main/ipc/ipc-rate-limiter.ts`, buckets keyed on `webContents.id` and evicted eagerly on renderer destroy); the legacy single-bucket API has been removed
- `webSecurity` is not disabled
- Web permissions are default-deny: `session.defaultSession.setPermissionRequestHandler` / `setPermissionCheckHandler` reject every permission except `clipboard-sanitized-write` (used by copy buttons); any new permission requires an explicit allowlist change in `electron/main/main.ts` (see ADR-0026)
- Production CSP pins `object-src 'none'` and `worker-src 'self' file:` in addition to the script/style/connect policy; the header CSP in `electron/main/main.ts` and the `<meta>` fallback in `vite.config.mts` are kept identical, enforced by `electron/main/__tests__/security-hardening.test.ts`
- Removed unnecessary `com.apple.security.network.server` entitlement from `electron/resources/entitlements.mac.plist` (the app is a client only)
- Encryption key for persisted store fetched from OS keychain via `safeStorage`; if unavailable, a startup warning is surfaced and the user is told plaintext fallback is active
- Renderer-cleanup deduplication via `electron/main/ipc/connection-cleanup.ts` prevents `destroyed` listener stacking across reconnects in streaming handlers
- Connect-time DNS-rebind pinning for HTTP, gRPC, WebSocket, and SSE (undici `Agent.connect.lookup`, `connect-node`'s `nodeOptions.lookup`, and `electron/main/security/safe-connect.ts`'s `createPinnedLookup` / `createPinnedFetch`); pre-flight DNS guard via `electron/main/security/dns-guard.ts` covers the rest (Socket.IO, MCP, gRPC reflection, Kafka, MQTT)

See `docs/adr/0004-security-hardening.md` and `docs/adr/0006-electron-connection-and-dns-hardening.md` for design rationale.

---

## CLI runner

The `@restura/cli` package (`cli/` directory) is the third backend consuming `shared/protocol/`. Where the Worker uses `globalThis.fetch` and Electron uses `undici` via `http-handler.ts`, the CLI uses `undici` directly via `cli/src/runner/undiciFetcher.ts`.

Components:

- `cli/src/runner/collectionLoader.ts` — walks a directory and parses every `_collection.yaml` + `*.{http,grpc,sse,mcp}.yaml` using the file-collection schema from `src/lib/shared/file-collection-schema.ts`
- `cli/src/runner/envLoader.ts` — loads env vars from JSON or YAML, with `${VAR}` expansion from `process.env`
- `cli/src/runner/runner.ts` — orchestrator: per-request, builds `RequestSpec` (resolving `{{KEY}}` against env + collection vars), calls `executeHttpProxy(spec, undiciFetcher, options)`, tallies results
- `cli/src/reporters/{json,junit,html,live}.ts` — implementations of the `Reporter` interface
- `cli/src/commands/run.ts` — Commander wire-up

Built with `tsup` into a single 40 KB esm file at `cli/dist/index.js`. Exit codes: 0 if all passed, 1 if any failed, 2 on internal error.

The CLI runs HTTP, GraphQL, gRPC (Connect), SSE, and MCP requests, and executes pre-request/test scripts in the same QuickJS sandbox the app uses (pass/fail comes from script assertions, not just HTTP 2xx). See `docs/cli/README.md` for the current capability list.

See `docs/cli/README.md` for usage and `docs/adr/0005-cli-runner.md` for design rationale.

---

## Testing

Tests are colocated with source files as `*.test.ts` / `*.test.tsx`. Vitest runs in jsdom environment with React Testing Library. Setup file: `tests/setup.ts`.

### Type-Check Coverage

CI type-checks several independent TypeScript projects — the root `tsconfig.json` excludes `worker`, `electron/main`, and the subprojects, so each needs its own invocation:

1. Renderer — `tsc --noEmit` (uses `tsconfig.json`)
2. Electron main — `tsc --noEmit -p electron/tsconfig.json`
3. HTTP feature — `tsc --noEmit -p src/features/http/tsconfig.json`
4. Worker — `tsc --noEmit -p worker/tsconfig.json`
5. Echo — `tsc --noEmit -p echo/tsconfig.json`
6. Echo-local — `tsc --noEmit -p echo-local/tsconfig.json`
7. CLI — `npm run --workspace cli type-check`
8. Chrome extension — `npm run --workspace @restura/extension type-check`
9. VS Code extension — `npm run --workspace restura-vscode type-check`

Run them all at once with `npm run type-check:all` (which `npm run validate` calls). Plain `npm run type-check` covers only the renderer.

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
5. **Zod at boundaries**: All external inputs (persisted-store hydration, IPC payloads, API responses) are validated with Zod schemas
6. **Sandbox scripts**: User-provided scripts never run in the browser's JavaScript context
