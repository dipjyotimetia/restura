# Architecture overview

Restura is built around one constraint: a single React SPA renderer serves three different deployment targets. The renderer code in `/src` is the same for the web app, the self-hosted Node/Docker server, and the Electron desktop app. Only the transport layer changes.

---

## Targets at a glance

| Target      | Transport               | Where the request originates                                                                           |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Web app     | `fetch /api/*`          | Cloudflare Worker (Hono app) running at the edge                                                       |
| Self-hosted | `fetch /api/*`          | Same Hono app, but running under `@hono/node-server` in a single Node process that also serves the SPA |
| Desktop     | `window.electron.*` IPC | Electron main process (Node.js) directly                                                               |

`src/lib/shared/platform.ts` exposes `isElectron()`; the renderer uses it at runtime to pick the transport path. The same protocol screen works on all targets without code changes.

---

## High-level data flow

```
┌──────────────────────────────────────────────────────────────┐
│                         React SPA                            │
│              /src  →  registry / feature modules               │
└───────────────┬────────────────────────┬───────────────────────┘
                │ Web / self-host        │ Electron
                ▼                        ▼
        Cloudflare Worker          Electron main process
        /worker/index.ts            /electron/main/main.ts
        Hono routes                 IPC handlers
                \                  /
                 ▼                ▼
          shared/protocol    shared/protocol
          (orchestrator)     (orchestrator)
                 \              /
                  ▼            ▼
                 Fetcher    Fetcher
                   │          │
                   ▼          ▼
              target API / service
```

Key point: the backend-specific code is limited to a thin `Fetcher` adapter plus transport-specific plumbing (WebSocket upgrades, native TCP, IPC channels). All validation, body construction, header sanitisation, auth signing, redirect following, and response shaping live in `/shared/protocol`.

---

## Shared protocol core

`/shared/protocol/` is the most important architectural boundary for request execution.

### Core modules

| Module                   | Responsibility                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `types.ts`               | `RequestSpec`, `Fetcher`, `ExecuteResult` discriminated union                                              |
| `http-proxy.ts`          | `executeHttpProxy(spec, fetcher, options)` — HTTP orchestrator with redirects, size cap, streaming variant |
| `grpc-proxy.ts`          | Connect-protocol HTTP/2 orchestrator for gRPC unary + server streaming                                     |
| `mcp-proxy.ts`           | JSON-RPC envelope validation for one-shot MCP calls                                                        |
| `websocket-proxy.ts`     | WebSocket handshake + framing orchestrator                                                                 |
| `sse-parser.ts`          | Canonical W3C SSE event parser                                                                             |
| `ndjson-parser.ts`       | Line-delimited JSON parser                                                                                 |
| `url-validation.ts`      | SSRF guard: RFC1918 private space, link-local, cloud metadata, DNS-rebind checks                           |
| `header-policy.ts`       | Hop-by-hop, proxy, and MCP-specific denied headers                                                         |
| `body-builder.ts`        | JSON / text / form-urlencoded / form-data / binary body construction                                       |
| `auth-signer.ts`         | AWS SigV4, OAuth1, NTLM, WSSE signing **after** body construction                                          |
| `redirect-follower.ts`   | Manual redirect loop; re-runs URL validation and auth stripping per hop                                    |
| `secret-value-schema.ts` | `SecretValue` / `SecretRef` value handle schema                                                            |
| `ai/`                    | Provider-agnostic AI chat orchestrator + per-provider decoders and redaction                               |

### The Fetcher pattern

Each backend injects `(req: FetcherRequest) => Promise<FetcherResponse>`:

- **Worker** — `worker/handlers/proxy.ts` wraps `globalThis.fetch` with `redirect: 'manual'`.
- **Node server** — reuses the same worker handler code under Node; `worker/node-entry.ts` adapts WebSocket upgrades.
- **Electron** — `electron/main/handlers/fetch-fetcher.ts` wraps Node `fetch`, with an optional DNS-pinned fetcher for HTTP/gRPC/WebSocket/SSE via `electron/main/security/safe-connect.ts`.
- **CLI** — `cli/src/runner/undiciFetcher.ts` builds an `undici` `Dispatcher` with TLS/proxy support.

Backend-only capabilities (SOCKS, PAC, mTLS, custom CA, OS keychain secret handles) live **inside the fetcher closure**, not in `shared/protocol`.

---

## Renderer architecture

### Entry and routing

- `src/main.tsx` — root render.
- `src/App.tsx` — hash router, theme/platform providers, lazy-loaded `AiLabWorkspace` route.
- `src/routes/index.tsx` — main workspace: sidebar, tab bar, request/response panels. Switches between protocol builders based on active tab type/override.
- `src/routes/not-found.tsx` — 404.

`createHashRouter` is intentional: the SPA works at `https://` (Pages) and at `file://` (Electron) without server-side routing.

### Feature layout

`src/features/` contains domain modules, each co-locating components, hooks, lib, stores, and type schemas:

```
src/features/<feature>/
  components/      → UI panels
  lib/             → executors, managers, helpers
  hooks/           → React hooks
  store/           → Zustand stores
  protocol.ts      → registry contract (defaultRequest, runRequest, startStream, Builder)
  index.ts         → public feature surface
```

Protocol features: `http`, `grpc`, `graphql`, `websocket`, `socketio`, `sse`, `mcp`, `kafka`, `mqtt`. Cross-cutting features: `collections`, `environments`, `workflows`, `scripts`, `auth`, `registry`, `contracts`, `load-testing`.

See [Protocol features](../features/protocols.md) for the registry contract and per-protocol notes.

### State

Zustand v5 with `persist` middleware. Persistence is pluggable:

- Web — Dexie/IndexedDB via `src/lib/shared/dexie-storage.ts`.
- Desktop — encrypted `electron-store` via `src/lib/shared/secure-storage.ts`; key wrapped by Electron `safeStorage` → OS keychain.

Stores of note:

- `useRequestStore` — tabs (`RequestTab[]`, `activeTabId`) and per-tab request/response state.
- `useCollectionStore` — collection tree, drag/drop, import/export mutations.
- `useEnvironmentStore` — environments, active env, variable resolution.
- `useWorkflowStore` — workflows, executions, graph state; uses `zundo` for undo/redo.
- `useFileCollectionStore` — Electron filesystem-backed collections and git sync.

---

## Backends in detail

### Cloudflare Worker

- Factory: `worker/app.ts` (`createApp(deps)`).
- Entry: `worker/index.ts` — mounts the app with Cloudflare-specific TCP proxy (`worker/shared/tcp-proxy.ts`) and WebSocketPair handler.
- Routes: `/api/proxy`, `/api/grpc`, `/api/grpc/reflection`, `/api/mcp`, `/api/telemetry/error`, `/api/feature-flags`, `/api/ws-ticket`, `/api/ws`.
- Auth/protection: `proxyAuthMiddleware` in `worker/app.ts` and rate limits.

### Self-hosted Node / Docker

- Entry: `worker/node-entry.ts` — runs `createApp` under `@hono/node-server`, serves the built SPA from `dist/web`, and handles Node WebSocket upgrades through `@hono/node-ws`.
- Platform adapters: `worker/shared/tcp-proxy-node.ts`, `worker/shared/dns-guard-node.ts`, `worker/handlers/websocket-node.ts`.
- Environment variables: `PORT`, `HOST`, `RESTURA_STATIC_ROOT`, `WORKER_PROXY_TOKEN`/`DEV_BYPASS_AUTH`. See `docs/SELF_HOSTING.md`.
- Important constraint from `CLAUDE.md`: `nodeEntry` must `Object.assign` onto `c.env`, not reassign it, because `@hono/node-ws` stamps state on that exact reference.

### Electron desktop

- Entry/orchestrator: `electron/main/main.ts`.
- `IPC_MODULES` registry couples each handler's `register` with its `dispose`; teardown cannot drift out of sync with registration.
- Preload: `electron/main/preload.ts` composes domain APIs from `electron/main/preload/` and exposes a typed `window.electron` API through `contextBridge`. Channel names come from `electron/shared/channels.ts`; the surface is validated against the composed modules under `electron/types/api/` via `satisfies ElectronAPI`.
- Window manager: `electron/main/window-manager.ts` loads `localhost:5173` in dev and `dist/web/index.html` in prod.
- Handlers: per-protocol IPC handlers in `electron/main/handlers/*.ts`. Heavy files include `http-handler.ts`, `grpc-handler.ts`, `grpc-connect.ts`, `kafka-handler.ts`, `mqtt-handler.ts`.
- Security: `electron/main/security/` contains DNS pinning, secret handle store, auth applier, collection export redaction.
- Stream lifecycle: `electron/main/ipc/stream-registry.ts` and `connection-cleanup.ts` centralise long-lived connections (SSE, WS, gRPC, Kafka, MQTT, MCP).

---

## Extension: browser capture

The browser-extension pipeline is implemented in `shared/capture/` (normaliser, classifier, secret-extractor, HAR / OpenCollection exporters). It reuses the same protocol and redaction primitives. See ADR 0024.

---

## Renderer architecture

### Routing

- `createHashRouter` from `react-router-dom` in `src/App.tsx`.
- `/` — main `Home` route with protocol panels.
- `/ai-lab` — separate full-screen AI Lab workbench, lazy-loaded.

### State management

Zustand is used everywhere. Persistent stores follow a pattern: store slice in `src/store/use<Name>Store.ts`, persistence options in `src/store/lib/`, and migration/logging in `src/lib/shared/persistence/`.

Key stores:

- `useRequestStore` — current request, tabs, active tab lifecycle.
- `useCollectionStore` — in-app collections/folders/requests.
- `useFileCollectionStore` — desktop filesystem-backed collections, git ops, watchers.
- `useWorkflowStore` — workflow definitions, step extraction rules, save state.
- `useEnvironmentStore` — environments and variable substitution.
- `useSettingsStore` — app settings including telemetry opt-out.

### Feature folders

`src/features/<name>/` generally contains:

- `components/` — React UI.
- `lib/` — pure logic (executors, validators, parsers).
- `hooks/` — React hooks.
- `protocol.ts` — renderer-side protocol registration and executor calls.
- `store.ts` — feature-local state.

`src/features/registry/bootstrap.ts` (imported in `src/main.tsx`) registers all built-in protocol modules with the singleton `ProtocolRegistry`. This avoids top-level dependencies inside the route file.

---

## Worker / backend architecture

`worker/app.ts` exports `createApp(deps)` which builds a Hono app with the following responsibilities:

- CORS (`resolveCorsOrigin` in `worker/app.ts`) — closed-by-default; operators must set `ALLOWED_ORIGIN`.
- Request-ID middleware.
- Rate limiting.
- `/api/proxy` — HTTP proxy via `shared/protocol/http-proxy.ts`.
- `/api/grpc`, `/api/grpc/reflection` — gRPC via `shared/protocol/grpc-proxy.ts`.
- `/api/mcp` — MCP proxy via `shared/protocol/mcp-proxy.ts`.
- `/api/ws-ticket`, `/api/ws` — WebSocket upgrade flow.
- `/api/telemetry/error` — web error reporting sink.
- `/api/feature-flags` — flags read from Cloudflare KV / Node env.

`worker/adapters.ts` defines the `AppDeps` interface: the implementations of CONNECT/TCP proxy and native WebSocket that differ between Cloudflare and Node.

---

## Desktop architecture

`electron/main/main.ts` bootstraps the Node main process:

- `electron/main/lifecycle/sentry.ts` — opt-in error reporting via renderer→main IPC bridge.
- `electron/main/window-manager.ts` — window creation, deep-link handlers.
- `electron/main/handlers/*-handler.ts` — IPC handlers per protocol.
- `electron/main/preload.ts` — context-isolated bridge exposed as `window.electron`.
- `electron/main/ipc/validators/` — domain-owned Zod schemas plus the trusted-sender handler boundary; `ipc-validators.ts` is the stable compatibility barrel.
- `electron/main/storage/` — encrypted JSON files backed by `safeStorage`.
- `electron/main/security/` — CSP, navigation guards, certificate handling.

The preload script is bundled separately (`npm run electron:bundle-preload`).

---

## Capability-driven gating

Because web and desktop have different sandboxes, features use the capability matrix in `src/lib/shared/capabilities.ts`. UI gates with `CapabilityBadge`; logic gates with `isCapableHere('feature.name', platform)`. The markdown matrix in `docs/CAPABILITY_MATRIX.md` is generated from `capabilities.ts` and checked in CI.

Examples of capability-only features:

- Kafka, MQTT, mTLS, SOCKS proxies — desktop only.
- AI assistant, AI Lab, local mock server, filesystem-backed collections — desktop only.
- Incremental HTTP response streaming — web only via Worker streams; desktop buffers through IPC.

---

## Source map

| Concern                      | Files                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| Renderer entry               | `src/main.tsx`, `src/App.tsx`, `src/routes/index.tsx`                                               |
| Hash routing                 | `src/App.tsx`                                                                                       |
| Protocol bootstrap           | `src/features/registry/bootstrap.ts`                                                                |
| Shared protocol core         | `shared/protocol/*.ts`, `shared/protocol/ai/**/*.ts`                                                |
| Worker backend factory       | `worker/app.ts`, `worker/index.ts`, `worker/node-entry.ts`                                          |
| WebSocket backend adapters   | `worker/handlers/websocket.ts`, `worker/handlers/websocket-node.ts`, `worker/handlers/ws-ticket.ts` |
| Desktop main process         | `electron/main/main.ts`, `electron/main/preload.ts`                                                 |
| Desktop protocol handlers    | `electron/main/handlers/*-handler.ts`                                                               |
| Desktop storage / encryption | `electron/main/storage/*.ts`, `src/lib/shared/encryption.ts`                                        |
| Capability matrix            | `src/lib/shared/capabilities.ts`, `docs/CAPABILITY_MATRIX.md`                                       |
| Platform detection           | `src/lib/shared/platform.ts`                                                                        |
| Architecture policy          | `scripts/architecture.config.mts`, `scripts/check-architecture.mts`                                 |

---

## What to watch out for when changing architecture

- `shared/` is the dependency floor: it must not import a runtime app, and Worker, Electron main, and CLI must not import renderer-owned `src/`. Renderer compatibility barrels may re-export shared owners. The checked rules live in `scripts/architecture.config.mts` (ADR 0028).
- SSRF guards belong in `shared/protocol/url-validation.ts`. Do not reimplement private-network checks in individual handlers.
- The Worker is not bundled into the desktop app. Any protocol feature that works on Electron must have a handler under `electron/main/handlers/`.
- `npm run type-check:all` is required; plain `type-check` skips the Worker, Electron main, CLI, and extensions.
- Run `npm run architecture:check` after moving modules or changing imports; it rejects forbidden directions, runtime cycles, and growth beyond the file-size ratchets.
- The Node backend mutates `c.env` in-place (`Object.assign`) because `@hono/node-ws` expects that exact reference. See `worker/node-entry.ts`.
