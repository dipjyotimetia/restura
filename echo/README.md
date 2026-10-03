# Restura Echo Server

A small Cloudflare Worker (deployed at `echo.restura.dev`) that acts as a **controlled, protocol-correct upstream** for trying Restura and for manual cross-protocol checks. The app's default placeholder URLs for HTTP, gRPC, GraphQL, WebSocket, and SSE point here (`src/lib/shared/echo-defaults.ts`; self-hosted builds can override them with the build-time `VITE_ECHO_*_URL` variables — see [`docs/SELF_HOSTING.md`](../docs/SELF_HOSTING.md)).

The automated suites do **not** depend on it: the `real-*` Playwright specs run against local, worker-scoped mock servers (`e2e/mocks/*`), and the desktop suite uses those mocks plus the native gRPC dev server. Handler behaviour is unit-tested in `echo/__tests__/`.

> **Not part of the production app.** This Worker is test infrastructure only. It is never bundled into the web app, the self-hosted server, or the desktop build.

## What it hosts

| Endpoint                    | Protocol              | Notes                                                       |
| --------------------------- | --------------------- | ----------------------------------------------------------- |
| `GET /ws`                   | WebSocket             | Plain WebSocket echo (`hono/cloudflare-workers` upgrade).   |
| `GET /sse`                  | Server-Sent Events    | Streams a sequence of SSE events.                           |
| `ALL /graphql`              | GraphQL               | Minimal GraphQL echo.                                       |
| `/*` (Connect)              | gRPC-Web / Connect    | Connect-protocol echo, matched before the HTTP fallthrough. |
| `POST /v1/chat/completions` | AI (OpenAI-shaped)    | For AI assistant / AI Lab tests.                            |
| `POST /v1/messages`         | AI (Anthropic-shaped) | For AI assistant / AI Lab tests.                            |
| `ALL *`                     | HTTP                  | Catch-all echo: reflects method, headers, query, and body.  |

**Socket.IO is intentionally not hosted here** — its stateful handshake and polling→WebSocket upgrade lifecycle depend on a Node `http.Server` and per-client server state, which don't map cleanly onto Workers. The Socket.IO e2e fixture is a Node server in `e2e/mocks/socketioServer.ts`. For native gRPC over real HTTP/2, mTLS, and Kafka/MQTT brokers, see the developer-facing [`echo-local/`](../echo-local/) stack instead — the Connect endpoint here is web-only.

## Develop & deploy

```bash
# Type-check (also run by `npm run type-check:all`)
npx tsc --noEmit -p echo/tsconfig.json

# Unit tests for the handlers
npx vitest run echo/__tests__

# Deploy to echo.restura.dev (from the repo root)
npm run deploy:echo

# Upload a preview version without promoting it
npm run deploy:echo:preview
```

Config lives in [`wrangler.jsonc`](./wrangler.jsonc) (`name: restura-echo`, custom domain `echo.restura.dev`, `nodejs_compat`). Requests are rate-limited via `middleware/rateLimiter.ts`.
