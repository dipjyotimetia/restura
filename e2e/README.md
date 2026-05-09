# Restura E2E Tests

End-to-end tests for the Restura web app, written with Playwright.

## Run

```bash
npm run test:e2e            # headless
npm run test:e2e:headed     # with the browser visible
npm run test:e2e:ui         # Playwright UI mode
npm run test:e2e:report     # open the last HTML report
```

That's it. From a fresh checkout `npm install && npm run test:e2e` is the
whole flow — the runner bootstraps everything automatically:

| Prereq | How it's auto-handled |
|---|---|
| Vite dev server (port 5173) | `webServer` config spawns `npm run dev`. CI starts cold; locally a hot dev server is reused. |
| Mock servers (HTTP/HTTPS/proxy/gRPC/WS/MCP) | Worker-scoped fixture in `e2e/fixtures/servers.ts` — one set per Playwright worker. |
| `.dev.vars` (worker dev mode) | Created/merged at config-load time by `bootstrapPrereqs()` in `e2e/global-setup.ts` — runs **before** miniflare starts so the worker boots in dev mode (auth bypass + localhost allowed). |
| Self-signed TLS cert | Generated lazily on first HTTPS server start, cached under `os.tmpdir()` between runs. |
| Playwright Chromium binary | Installed once via `playwright install chromium` from `globalSetup` if the cache is missing. |

## Layout

```
e2e/
├── fixtures/
│   ├── app.ts                # Onboarding-skipping page fixture
│   └── servers.ts            # Worker-scoped fixture spinning up mock servers
├── mocks/
│   ├── cert.ts               # Self-signed TLS cert generator
│   ├── httpServer.ts         # Plain HTTP + HTTPS mock with httpbin-style routes
│   ├── proxyServer.ts        # CONNECT-tunneling HTTP proxy server
│   ├── grpcServer.ts         # Connect-RPC JSON server (echo + reflection)
│   └── proto/echo.proto      # Reference IDL for the mock gRPC service
├── utils/
│   ├── selectors.ts          # Stable role/label selectors for common controls
│   ├── configureProxy.ts     # Drives the Settings → Proxy UI
│   └── mockProxy.ts          # Playwright-route-level mock for /api/proxy
├── http.spec.ts              # HTTP flow with route-level mocking
├── protocols.spec.ts         # GraphQL, gRPC, WebSocket, SSE protocol switching
├── data-management.spec.ts   # Collections, environments, settings, theme
├── real-http.spec.ts         # Real network I/O against mock HTTP server
├── real-https.spec.ts        # Real TLS against mock HTTPS server (self-signed)
├── real-proxy.spec.ts        # Real proxy CONNECT/forward verification
└── real-grpc.spec.ts         # Worker-driven gRPC against mock Connect server
```

## Two test layers

**1. Route-mocked tests** (`http.spec.ts`, `protocols.spec.ts`,
`data-management.spec.ts`) intercept network at Playwright's request layer.
Fast and hermetic — good for UI behavior assertions.

**2. Real-server tests** (`real-*.spec.ts`) run against actual local servers
launched as worker-scoped fixtures. Real sockets, real TLS, real proxy
tunneling, real Worker → upstream traversal. Catches issues that mocks miss.

```
[browser]
   │
   ├─ direct axios  ───────────────────────────►  [mock HTTP / HTTPS server]
   │                                                  127.0.0.1:<random>
   │
   └─ /api/proxy, /api/grpc  ──►  [Worker]  ──►  [mock HTTP / gRPC server]
                                     │
                                     └─ optional ─►  [mock proxy]  ──► upstream
```

## Mock servers

All six mock servers bind to `127.0.0.1:0` (random free port) and are
shared via a worker-scoped fixture (`fixtures/servers.ts`). Each test gets
fresh request counters via `reset()` between tests.

| Server  | Purpose                                                                      | URL exposed         |
|---------|------------------------------------------------------------------------------|---------------------|
| HTTP    | httpbin-style + GraphQL + SSE/NDJSON streams (`/json`, `/echo`, `/graphql`, `/stream/sse`, `/stream/ndjson`, `/status/:code`, …) | `servers.http.url`  |
| HTTPS   | Same routes, self-signed cert                                                | `servers.https.url` |
| Proxy   | CONNECT tunnel + plain HTTP forward                                          | `servers.proxy.url` |
| gRPC    | Connect-RPC JSON: unary echo + server-streaming + reflection                 | `servers.grpc.url`  |
| WS      | `/echo`, `/chat` broadcast, `/graphql` graphql-transport-ws                  | `servers.ws.url`    |
| MCP     | Streamable-HTTP JSON-RPC: `initialize`, `tools/list`, `tools/call`           | `servers.mcp.url`   |

Counters and request recordings are exposed for assertions:
`servers.http.requestCount()`, `servers.proxy.connectHosts()`,
`servers.ws.receivedMessages()`, `servers.mcp.methodsReceived()`, etc.

### Streaming coverage matrix

| Protocol  | Variant                | Browser-driven? | Wire test? |
|-----------|------------------------|-----------------|------------|
| gRPC      | Unary                  | yes (Worker)    | yes        |
| gRPC      | Server-streaming       | UI panel only*  | yes (Connect envelope framing) |
| gRPC      | Client-streaming       | stubbed         | stub assertion |
| gRPC      | Bidirectional          | stubbed         | stub assertion |
| GraphQL   | Query                  | yes             | yes        |
| GraphQL   | Mutation               | yes             | yes        |
| GraphQL   | Subscription           | UI hook only    | covered by WS `/graphql` graphql-transport-ws |
| SSE       | unnamed `message`      | yes             | yes        |
| SSE       | named events           | n/a (Restura uses native EventSource onmessage) | yes |
| WebSocket | text                   | yes             | yes        |
| WebSocket | binary (hex)           | yes             | yes        |
| WebSocket | broadcast/multiplex    | n/a             | yes (`/chat`) |
| MCP       | initialize             | yes             | yes        |
| MCP       | tools/list             | yes             | yes        |
| MCP       | tools/call             | yes (UI Tools)  | yes        |

\* gRPC server-streaming uses direct fetch from the renderer with Connect
envelope framing. Restura's UI gates streaming method types behind the
desktop build, so the browser-driven test verifies the streaming UI panel
exists; full streaming round-trip is covered at the wire layer.

## Adding tests

For UI-only assertions, prefer the lighter `fixtures/app.ts`:

```ts
import { test, expect } from './fixtures/app';
test('my flow', async ({ app: page }) => { /* … */ });
```

For real-network verification, use `fixtures/servers.ts`:

```ts
import { test, expect } from './fixtures/servers';
test('flow that hits a real server', async ({ app: page, servers }) => {
  await page.getByRole('textbox', { name: 'Request URL' })
    .fill(`${servers.http.url}/json`);
  // …
});
```

Selectors should prefer `getByRole` / `getByLabel` over CSS classes — they
survive component refactors and Tailwind churn far better.
