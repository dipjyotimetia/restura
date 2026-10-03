# Restura E2E Tests

End-to-end tests for the Restura web app, written with Playwright.

## Run

```bash
npm run test:e2e            # headless
npm run test:e2e:headed     # with the browser visible
npm run test:e2e:ui         # Playwright UI mode
npm run test:e2e:report     # open the last HTML report
npm run test:e2e:extension  # Chrome capture extension (builds it, then runs extension-capture.spec.ts)
```

The default config skips `extension-capture.spec.ts`; it runs only under
`playwright.extension.config.ts`. The **desktop** (Electron) suite lives in
`e2e-electron/` — see the [end-to-end testing guide](https://docs.restura.dev/testing/end-to-end/) (`npm run test:e2e:electron:build && npm run test:e2e:electron`).

That's it. From a fresh checkout `npm install && npm run test:e2e` is the
whole flow — the runner bootstraps everything automatically:

| Prereq                                      | How it's auto-handled                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite dev server (port 5173)                 | `webServer` config spawns `npm run dev`. CI starts cold; locally a hot dev server is reused.                                                                                              |
| Mock servers (HTTP/HTTPS/proxy/gRPC/WS/MCP) | Worker-scoped fixture in `e2e/fixtures/servers.ts` — one set per Playwright worker.                                                                                                       |
| `.dev.vars` (worker dev mode)               | Created/merged at config-load time by `bootstrapPrereqs()` in `e2e/global-setup.ts` — runs **before** miniflare starts so the worker boots in dev mode (auth bypass + localhost allowed). |
| Self-signed TLS cert                        | Generated lazily on first HTTPS server start, cached under `os.tmpdir()` between runs.                                                                                                    |
| Playwright Chromium binary                  | Installed once via `playwright install chromium` from `globalSetup` if the cache is missing.                                                                                              |

## Layout

```
e2e/
├── fixtures/
│   ├── app.ts                # Onboarding-skipping page fixture
│   ├── servers.ts            # Worker-scoped fixture spinning up the mock servers
│   ├── mqtt.ts               # Loopback-broker window.electron mock for the MQTT UI
│   └── import/               # Collection files used by import-collection.spec.ts
├── mocks/
│   ├── cert.ts               # Self-signed TLS cert generator
│   ├── httpServer.ts         # Plain HTTP + HTTPS mock with httpbin-style routes
│   ├── authRoutes.ts         # OAuth2/JWT/SigV4/Digest/WSSE/OAuth1 verification routes
│   ├── oauth1Verify.ts       # Independent RFC 5849 verifier (shares no code with the signer)
│   ├── graphqlSchema.ts      # Schema served by the HTTP mock's /graphql route
│   ├── proxyServer.ts        # CONNECT-tunneling HTTP proxy server
│   ├── socksProxyServer.ts   # SOCKS5 proxy (desktop + echo-local)
│   ├── grpcServer.ts         # Connect-RPC JSON server (echo + reflection)
│   ├── wsServer.ts           # WebSocket echo / chat / graphql-transport-ws
│   ├── socketioServer.ts     # Socket.IO server (namespaces /, /chat, /admin)
│   ├── mcpServer.ts          # Streamable-HTTP MCP server
│   ├── mcpV2Server.ts        # MCP server on the v2 SDK (used by the e2e-electron suite)
│   └── proto/echo.proto      # Reference IDL for the mock gRPC service
├── utils/
│   ├── selectors.ts          # Stable role/label selectors for common controls
│   ├── configureProxy.ts     # Drives the Settings → Proxy UI
│   ├── mockProxy.ts          # Playwright-route-level mock for /api/proxy
│   ├── reset-state.ts        # Clears persisted app state between tests
│   └── serverHelpers.ts      # Loopback bind / CORS / close helpers for the mock servers
├── *.spec.ts                 # Route-mocked UI specs (http, protocols, data-management,
│                             #   collection-runner, import-collection, persistence, …)
├── real-*.spec.ts            # Real network I/O through the Worker (http, proxy, grpc,
│                             #   graphql, websocket, sse, socketio, mcp, mqtt, auth, ai, …)
└── extension-capture.spec.ts # Chrome extension (run via test:e2e:extension only)
```

> **Self-signed HTTPS upstreams are a desktop-only scenario.** The web Send
> routes through the Worker (`/api/proxy`), and workerd cannot trust a
> self-signed cert (custom-CA / cert import is desktop-only — see
> `src/lib/shared/capabilities.ts`, `http.customCa`). Real TLS-handshake
> behaviour (custom CA, mTLS, protocol floors, ciphers) is covered by the
> **Electron** suite at `e2e-electron/specs/tls.spec.ts`.

## Two test layers

**1. Route-mocked tests** (`http.spec.ts`, `protocols.spec.ts`,
`data-management.spec.ts`, and the other non-`real-*` specs) intercept network at Playwright's request layer.
Fast and hermetic — good for UI behavior assertions.

**2. Real-server tests** (`real-*.spec.ts`) run against actual local servers
launched as worker-scoped fixtures. Real sockets, real TLS, real proxy
tunneling, real Worker → upstream traversal. Catches issues that mocks miss.

```
[browser]
   │
   └─ /api/proxy, /api/grpc  ──►  [Worker]  ──►  [mock HTTP / gRPC server]
                                     │               127.0.0.1:<random>
                                     └─ optional ─►  [mock proxy]  ──► upstream
```

All web requests go through the Worker — the renderer never speaks HTTP to a
user-supplied upstream directly (see `src/lib/shared/transport.ts`).

## Mock servers

All seven mock servers bind to `127.0.0.1:0` (random free port) and are
shared via a worker-scoped fixture (`fixtures/servers.ts`). Each test gets
fresh request counters via `reset()` between tests.

| Server | Purpose                                                                                                                          | URL exposed         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| HTTP   | httpbin-style + GraphQL + SSE/NDJSON streams (`/json`, `/echo`, `/graphql`, `/stream/sse`, `/stream/ndjson`, `/status/:code`, …) | `servers.http.url`  |
| HTTPS  | Same routes, self-signed cert                                                                                                    | `servers.https.url` |
| Proxy  | CONNECT tunnel + plain HTTP forward                                                                                              | `servers.proxy.url` |
| gRPC   | Connect-RPC JSON: unary echo + server-streaming + reflection                                                                     | `servers.grpc.url`  |
| WS     | `/echo`, `/chat` broadcast, `/graphql` graphql-transport-ws                                                                      | `servers.ws.url`    |
| MCP    | Streamable-HTTP JSON-RPC: `initialize`, `tools/list`, `tools/call`                                                               | `servers.mcp.url`   |
| Socket.IO | Namespaces `/`, `/chat`, `/admin`; emit/listen + acknowledgements                                                             | `servers.socketio.url` |

Counters and request recordings are exposed for assertions:
`servers.http.requestCount()`, `servers.proxy.connectHosts()`,
`servers.ws.receivedMessages()`, `servers.mcp.methodsReceived()`, etc.

### Streaming coverage matrix

| Protocol  | Variant             | Browser-driven?                                 | Wire test?                                    |
| --------- | ------------------- | ----------------------------------------------- | --------------------------------------------- |
| gRPC      | Unary               | yes (Worker)                                    | yes                                           |
| gRPC      | Server-streaming    | UI "Web Stream" panel only\*                    | yes (Connect envelope framing)                |
| gRPC      | Client-streaming    | n/a (desktop-only)                              | yes (Connect-Node gRPC HTTP/2 transport)      |
| gRPC      | Bidirectional       | n/a (desktop-only)                              | yes (Connect-Node gRPC HTTP/2 transport)      |
| GraphQL   | Query               | yes                                             | yes                                           |
| GraphQL   | Mutation            | yes                                             | yes                                           |
| GraphQL   | Subscription        | UI hook only                                    | covered by WS `/graphql` graphql-transport-ws |
| SSE       | unnamed `message`   | yes                                             | yes                                           |
| SSE       | named events        | wire only                                       | yes (`/stream/sse-named`)                     |
| WebSocket | text                | yes                                             | yes                                           |
| WebSocket | binary (hex)        | yes                                             | yes                                           |
| WebSocket | broadcast/multiplex | n/a                                             | yes (`/chat`)                                 |
| MCP       | initialize          | yes                                             | yes                                           |
| MCP       | tools/list          | yes                                             | yes                                           |
| MCP       | tools/call          | yes (UI Tools)                                  | yes                                           |

\* On web, gRPC server-streaming connects directly from the renderer with
Connect envelope framing (CORS permitting) rather than through `/api/grpc`;
client and bidirectional streaming are desktop-only (see `grpc.basic` in
`src/lib/shared/capabilities.ts`). The browser-driven test verifies the
"Web Stream" panel; the full streaming round-trip is covered at the wire
layer. Web SSE is streamed through the Worker's `/api/proxy` (no native
`EventSource`).

## Adding tests

For UI-only assertions, prefer the lighter `fixtures/app.ts`:

```ts
import { test, expect } from './fixtures/app';
test('my flow', async ({ app: page }) => {
  /* … */
});
```

For real-network verification, use `fixtures/servers.ts`:

```ts
import { test, expect } from './fixtures/servers';
test('flow that hits a real server', async ({ app: page, servers }) => {
  await page.getByRole('textbox', { name: 'Request URL' }).fill(`${servers.http.url}/json`);
  // …
});
```

Selectors should prefer `getByRole` / `getByLabel` over CSS classes — they
survive component refactors and Tailwind churn far better.
