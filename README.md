<div align="center">

<img src=".github/assets/banner.svg" alt="Restura — the API client that speaks every protocol" width="100%">

<br/>

[![CI](https://img.shields.io/github/actions/workflow/status/dipjyotimetia/restura/ci.yml?style=flat-square&label=CI&labelColor=14121F&color=6366F1)](https://github.com/dipjyotimetia/restura/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dipjyotimetia/restura?style=flat-square&label=release&labelColor=14121F&color=6366F1)](https://github.com/dipjyotimetia/restura/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-6366F1?style=flat-square&labelColor=14121F)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-6366F1?style=flat-square&labelColor=14121F)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-6366F1?style=flat-square&labelColor=14121F)](https://www.typescriptlang.org)

<br/>

[![Live App](https://img.shields.io/badge/Live_App-6366F1?style=for-the-badge&logo=cloudflare&logoColor=white)](https://restura.dev/)
&nbsp;
[![Download](https://img.shields.io/badge/Download_Desktop-14121F?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/dipjyotimetia/restura/releases/latest)
&nbsp;
<a href="https://docs.restura.dev/" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Documentation-14121F?style=for-the-badge&logo=readthedocs&logoColor=white" alt="Documentation"></a>

</div>

<br/>

> **One client. Every protocol.** Test HTTP endpoints, debug gRPC services, send WebSocket frames, watch SSE streams, and call MCP servers — all from one place. No account. No data leaving your machine.

Restura is a multi-protocol API client for developers who are tired of switching tools. It runs as a **web app** on Cloudflare's edge and as a native **desktop app** for macOS, Windows, and Linux — built from a single React renderer, so the two stay perfectly in sync.

**Both are free forever.**

<br/>

<!-- ─────────────────────────────────────────────────────────────────────────
     A LOOK INSIDE
     Drop your screenshot at .github/assets/restura-screenshot.png and it
     renders here automatically. See .github/assets/ASSETS.md for specs.
────────────────────────────────────────────────────────────────────────── -->

<div align="center">

### A look inside

<!-- Uncomment the line below once .github/assets/restura-screenshot.png is committed -->
<!-- <img src=".github/assets/restura-screenshot.png" alt="Restura desktop app — HTTP request with response inspector, network console, and timing waterfall" width="92%"> -->

<sub>Multi-tab requests · response inspector · network console · timing waterfall</sub>

</div>

<br/>

## Protocols

|        | Protocol               | What works today                                            |
| :----: | ---------------------- | ----------------------------------------------------------- |
| `HTTP` | REST / HTTP            | All methods, params, headers, body types, cookies, code gen |
| `GQL`  | GraphQL                | Query builder, schema introspection, subscriptions          |
| `RPC`  | gRPC                   | Unary, server streaming, server reflection                  |
|  `WS`  | WebSocket              | Connect, send/receive, full message history                 |
|  `IO`  | Socket.IO              | Connect, emit/listen events, acks · _desktop only_          |
| `SSE`  | Server-Sent Events     | Live event stream viewer with reconnection                  |
| `KFK`  | Kafka                  | Produce / consume, SASL + TLS · _desktop only_              |
| `MCP`  | Model Context Protocol | Proxy to any MCP server                                     |

## Highlights

|                        |                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Request scripting**  | Pre-request and test scripts in JavaScript, sandboxed in [QuickJS](https://bellard.org/quickjs/) WASM — no DOM, no network escape. |
| **Workflows**          | Chain requests, extract variables via JSONPath / regex / headers, set retries with exponential backoff.                            |
| **Import everything**  | Postman v2.1, Insomnia, and OpenAPI / Swagger — drop it in and start testing.                                                      |
| **Environments**       | Scope variables per environment; swap `{{base_url}}` between staging and prod in one click.                                        |
| **Auth built-in**      | Basic, Bearer, API Key, OAuth 2.0, Digest, AWS SigV4, mTLS — per request or inherited from a collection or folder.                 |
| **Proxy support**      | HTTP/HTTPS proxies, proxy chaining, client certificates.                                                                           |
| **Private by default** | Everything stored locally. No accounts, no cloud sync.                                                                             |

## Security

Restura signs auth **at the wire** and guards every outbound request — on both the web Worker and the desktop main process.

- **Desktop (Electron)** — Encryption keys are wrapped by the OS keychain via Electron `safeStorage` (macOS Keychain, Windows Credential Manager, Linux libsecret); data is sealed with AES-256-GCM. mTLS, custom CA certs, SOCKS proxies, PAC resolution, and disabling TLS verification all work through Node's TLS / `net` stack.
- **Web** — Encryption keys default to ephemeral in-memory (regenerated per session) — strictly better than storing the key beside the ciphertext, though it means encrypted data doesn't survive a reload. mTLS, custom CA, SOCKS, and "Verify SSL = off" aren't exposed by the browser sandbox.
- **Network** — SSRF guards (RFC 1918, RFC 6598 CGNAT, link-local `169.254/16`, cloud-metadata endpoints, IPv6 unique-local, IPv4-mapped IPv6) on every path. Desktop adds a DNS-rebind guard at lookup time. AWS SigV4 is signed in the Worker / Electron handler — never the renderer — so the signature matches the exact bytes upstream receives.
- **Sandbox** — User scripts run in a [QuickJS](https://bellard.org/quickjs/) WASM VM with memory and time limits. No host bridge, no filesystem, no network.
- **Privacy** — No accounts, no cloud sync. Optional crash & error reporting (desktop, Sentry) captures stack traces, native crash reports, and URL-free performance signals — request context, headers, bodies, secrets, and file paths are aggressively scrubbed before anything is sent (`sendDefaultPii: false`), and it can be turned off in Settings. Your requests and responses never leave your machine.

See [`docs/adr/0004-security-hardening.md`](docs/adr/0004-security-hardening.md) for the design rationale.

## Quick start

**Prerequisites:** Node.js 24+ and npm.

```bash
git clone https://github.com/dipjyotimetia/restura.git
cd restura
npm install
npm run dev          # → http://localhost:5173
```

One command boots the Vite dev server **and** the Cloudflare Worker proxy (via Miniflare).

<details>
<summary><b>Desktop app (build from source)</b></summary>

<br/>

Prebuilt installers live on the [**releases page**](https://github.com/dipjyotimetia/restura/releases/latest). To build locally:

```bash
npm run electron:dev              # development (live reload)

npm run electron:dist:mac         # macOS   → DMG + ZIP  (x64 + arm64)
npm run electron:dist:win         # Windows → NSIS + portable (x64 + ia32)
npm run electron:dist:linux       # Linux   → AppImage + deb + rpm (x64)
```

</details>

<details>
<summary><b>Self-hosting (Docker)</b></summary>

<br/>

Run the web app behind your firewall in a single Node container — no Cloudflare account required.

```bash
cp .env.example .env              # set WORKER_PROXY_TOKEN + ALLOWED_ORIGIN
docker compose up -d --build
curl -fs http://localhost:3000/health
```

See [**docs/SELF_HOSTING.md**](docs/SELF_HOSTING.md) for the full operations guide — auth modes, internal-network access, reverse-proxy examples, healthchecks.

</details>

## How it works

The same React SPA powers both targets. The only thing that differs is the transport, chosen at runtime by `isElectron()`.

```
          ┌──────────────────────────────────────┐
          │          React SPA (renderer)        │
          │   Vite · React 19 · React Router v7  │
          └────────────┬─────────────┬───────────┘
                       │             │
                web    │             │   desktop
                       ▼             ▼
          ┌─────────────────┐  ┌──────────────────────┐
          │   Cloudflare    │  │   Electron main       │
          │   Worker (Hono) │  │   Native IPC handlers │
          └────────┬────────┘  └──────────┬────────────┘
                   │                       │
                   └───────────┬───────────┘
                               ▼
                       Target API / Service
```

The Cloudflare Worker is never bundled into the desktop app. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full breakdown.

<details>
<summary><b>Project layout</b></summary>

<br/>

```
src/
├── features/
│   ├── http/          # REST request builder & executor
│   ├── grpc/          # gRPC client + server reflection
│   ├── websocket/     # WebSocket client
│   ├── socketio/      # Socket.IO client (desktop only)
│   ├── graphql/       # GraphQL builder + schema explorer
│   ├── sse/           # Server-Sent Events client
│   ├── kafka/         # Kafka producer/consumer (desktop only)
│   ├── mcp/           # MCP client
│   ├── workflows/     # Request chaining + variable extraction
│   ├── collections/   # Sidebar, runner, Postman/Insomnia import
│   ├── environments/  # Environment variable manager
│   ├── auth/          # Auth config (shared across protocols)
│   └── scripts/       # Script editor + QuickJS executor
│
worker/                # Cloudflare Pages Function (Hono, web only)
electron/main/         # Electron main process + IPC handlers
```

</details>

## Stack

| Concern    | Choice                                                          |
| ---------- | --------------------------------------------------------------- |
| Build      | Vite 8 + `@cloudflare/vite-plugin`                              |
| UI         | React 19 · Tailwind CSS v4 · shadcn/ui · Radix UI               |
| Routing    | React Router v7 (hash mode — works on `file://` and `https://`) |
| State      | Zustand v5 with `persist` middleware                            |
| Validation | Zod v4                                                          |
| Editor     | Monaco Editor                                                   |
| Script VM  | QuickJS WASM (`quickjs-emscripten`)                             |
| Worker     | Hono on Cloudflare Pages Functions                              |
| Desktop    | Electron 42                                                     |
| Tests      | Vitest + React Testing Library                                  |

## Development

```bash
npm run dev              # web dev server (port 5173)
npm run validate         # type-check + lint + tests (same as CI)
npm run test:run         # tests once
npm run test:coverage    # coverage report
npm run lint             # ESLint
npm run format           # Prettier
```

Every PR runs type-check (renderer + Electron main + Worker), lint, security audit, tests, build, and a Cloudflare Pages preview deploy with the URL posted to the PR.

## Contributing

All contributions are welcome — bug fixes, new features, docs.

```bash
git checkout -b fix/my-thing
# make changes
npm run validate
git commit -m 'fix: my thing'
# open a PR
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, commit format, and the PR checklist. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Links

- <a href="https://docs.restura.dev/" target="_blank" rel="noopener noreferrer"><b>Documentation</b></a> — guides, references, and how-tos
- [**Architecture**](docs/ARCHITECTURE.md) — system design, security model, IPC internals
- [**Roadmap**](docs/ROADMAP.md) — what's planned
- [**Changelog**](docs/CHANGELOG.md) — what's shipped
- [**Security**](SECURITY.md) — how to report vulnerabilities

<br/>

<div align="center">

**MIT License** · Hosted on Cloudflare Pages · Made by [**dipjyotimetia**](https://github.com/dipjyotimetia)

<sub>If Restura saves you a tab, consider leaving a ⭐ — it genuinely helps.</sub>

</div>
