<div align="center">

# Restura

**The API client that speaks every protocol.**

🌐 HTTP · 🧬 GraphQL · ⚙️ gRPC · 💬 WebSocket · 🔌 Socket.IO · 🔥 SSE · 📨 Kafka · 🤖 MCP

[![CI](https://github.com/dipjyotimetia/restura/actions/workflows/ci.yml/badge.svg)](https://github.com/dipjyotimetia/restura/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org)
[![Cloudflare Pages](https://img.shields.io/badge/deployed%20on-Cloudflare%20Pages-F38020)](https://restura.pages.dev)

[**Live app →**](https://restura.pages.dev) &nbsp;·&nbsp; [**Download**](#desktop-app) &nbsp;·&nbsp; [**Docs**](docs/ARCHITECTURE.md) &nbsp;·&nbsp; [**Changelog**](docs/CHANGELOG.md)

</div>

---

Restura is a multi-protocol API client for developers who are tired of switching tools. Test HTTP endpoints, debug gRPC services, send WebSocket frames, watch SSE streams, and call MCP servers — all from one place, with no account required and no data leaving your machine.

It runs as a **web app** on Cloudflare Pages and as a native **desktop app** on macOS, Windows, and Linux. Cloudflare Pages and Cloudflare Workers power the public web deployment, giving the app fast edge hosting, secure same-origin proxying, and a reliable preview environment for contributors.

Both are free forever.

---

## Protocols 🧩

| | Protocol | What works today |
|:---:|---|---|
| `HTTP` | REST / HTTP | All methods, params, headers, body types, cookies, code gen |
| `GQL` | GraphQL | Query builder, schema introspection, subscriptions |
| `RPC` | gRPC | Unary, server streaming, server reflection |
| `WS` | WebSocket | Connect, send/receive, full message history |
| `IO` | Socket.IO | Connect, emit/listen events, acks (desktop only) |
| `SSE` | Server-Sent Events | Live event stream viewer with reconnection |
| `KFK` | Kafka | Produce / consume, SASL + TLS (desktop only) |
| `MCP` | Model Context Protocol | Proxy to any MCP server |

---

## Highlights ✨

**Request scripting** — Write pre-request and test scripts in JavaScript. They run in an isolated [QuickJS](https://bellard.org/quickjs/) WASM sandbox: no DOM access, no network escape.

**Workflows** — Chain requests sequentially. Extract variables from responses using JSONPath, regex, or headers. Set retry policies with exponential backoff.

**Import everything** — Drop in a Postman v2.1 collection, Insomnia export, or OpenAPI/Swagger spec and start testing immediately.

**Environments** — Scope variables to environments. Swap `{{base_url}}` between staging and production with one click.

**Auth built-in** — Basic, Bearer, API Key, OAuth 2.0, Digest, AWS Signature v4, mTLS certificates — configured once per request or inherited from a collection.

**Proxy support** — Route through HTTP/HTTPS proxies, chain proxies, attach client certificates.

**Privacy first** — Everything is stored locally (IndexedDB on web, encrypted electron-store on desktop). No accounts, no telemetry, no cloud sync.

---

## Security model 🔒

Restura's security posture is asymmetric between the desktop and web clients by virtue of platform capability gaps. The web client surfaces a "Desktop only" badge on UI fields whose underlying capability isn't available in the browser.

- **Desktop (Electron)** — Encryption keys are persisted via Electron's `safeStorage`, which wraps them with the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret). Stored data is encrypted with AES-256-GCM keyed by that hardware-backed key. mTLS, custom CA certificates, SOCKS proxies, PAC resolution, and disabling TLS verification all work because Electron uses Node's TLS / `net` stack.
- **Web** — Encryption keys default to in-memory ephemeral (regenerated per session) — strictly better than persisting the key alongside the ciphertext, but it does mean encrypted data does not survive a reload. A future release will add an opt-in passphrase prompt that derives a stable session key via PBKDF2; for now, web users opting into encryption should treat it as session-scoped. mTLS, custom CA, SOCKS, and "Verify SSL = off" are not available in the web client because the browser sandbox doesn't expose them.
- **Network** — SSRF guards (RFC 1918, RFC 6598 CGNAT, link-local 169.254/16, cloud metadata endpoints, IPv6 unique-local, IPv4-mapped IPv6) on both Worker and Electron paths. Electron additionally enforces a DNS-rebind guard at lookup time. AWS SigV4 is signed at the wire (in the Worker / Electron handler, not the renderer) so the signature matches the exact bytes the upstream receives.
- **Sandbox** — User pre-request and test scripts run in a [QuickJS](https://bellard.org/quickjs/) WASM sandbox with memory and execution-time limits. No host bridge, no filesystem, no network.

See [`docs/adr/0004-security-hardening.md`](docs/adr/0004-security-hardening.md) for design rationale.

---

## Quick Start 🚀

**Prerequisites:** Node.js 24+, npm

### Web

```bash
git clone https://github.com/dipjyotimetia/restura.git
cd restura
npm install
npm run dev
```

Visit **http://localhost:5173**. One command starts the Vite dev server *and* the Cloudflare Worker proxy via Miniflare.

### Desktop App

```bash
npm run electron:dev              # development (live reload)

npm run electron:dist:mac         # macOS   → DMG + ZIP  (x64 + arm64)
npm run electron:dist:win         # Windows → NSIS + portable (x64 + ia32)
npm run electron:dist:linux       # Linux   → AppImage + deb + rpm (x64)
```

### Self-hosting (Docker)

Run the web app behind your firewall in a single Node container — no Cloudflare account required.

```bash
cp .env.example .env              # set WORKER_PROXY_TOKEN + ALLOWED_ORIGIN
docker compose up -d --build
curl -fs http://localhost:3000/health
```

See **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)** for the full operations guide (auth modes, internal-network access, reverse-proxy examples, healthchecks).

---

## How it works

The same React SPA powers both web and desktop. The only difference is the transport layer:

```
          ┌──────────────────────────────────────┐
          │         React SPA (renderer)         │
          │  Vite · React 19 · React Router v7   │
          └────────────┬─────────────┬───────────┘
                       │             │
              web       │             │  desktop
                       ▼             ▼
          ┌─────────────────┐  ┌──────────────────────┐
          │  Cloudflare     │  │  Electron main        │
          │  Worker (Hono)  │  │  Native IPC handlers  │
          └────────┬────────┘  └──────────┬────────────┘
                   │                      │
                   └──────────┬───────────┘
                              ▼
                       Target API / Service
```

The renderer calls `isElectron()` to pick the right transport at runtime. The Worker is never bundled into the Electron app.

---

## Project Layout

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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full breakdown.

---

## Stack

| Concern | Choice |
|---|---|
| Build | Vite 8 + `@cloudflare/vite-plugin` |
| UI | React 19, TailwindCSS v4, shadcn/ui, Radix UI |
| Routing | React Router v7 (hash mode — works on `file://` and `https://`) |
| State | Zustand v5 with `persist` middleware |
| Validation | Zod v4 |
| Editor | Monaco Editor |
| Script VM | QuickJS WASM (`quickjs-emscripten`) |
| Worker | Hono on Cloudflare Pages Functions |
| Desktop | Electron 42 |
| Tests | Vitest + React Testing Library |

---

## Development

```bash
npm run dev              # web dev server (port 5173)
npm run validate         # type-check + lint + tests (same as CI)
npm run test:run         # tests once
npm run test:coverage    # coverage report
npm run lint             # ESLint
npm run format           # Prettier
```

CI runs on every PR: type-check (renderer + Electron main + Worker), lint, security audit, tests, build, and a Cloudflare Pages preview deploy with the URL posted to the PR.

---

## Contributing 🤝

All contributions are welcome — bug fixes, new features, docs improvements.

```bash
git checkout -b fix/my-thing
# make changes
npm run validate
git commit -m 'fix: my thing'
# open a PR
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, commit format, and the PR checklist.

## Open source & community 🌍

Restura is open source under the MIT License and designed to be welcoming for contributors:

- `MIT` licensing for use, contribution, and redistribution.
- `CONTRIBUTING.md` for development workflows, branch policies, and PR guidance.
- `CODE_OF_CONDUCT.md` for respectful, community-first collaboration.
- CI validates every PR with types, linting, tests, and Cloudflare Pages preview deploys.

The public web app is hosted on Cloudflare Pages with a Cloudflare Workers backend, which provides free edge-hosted delivery, secure API proxying, and a stable contributor preview environment.

---

## Links 🔗

- [Architecture](docs/ARCHITECTURE.md) — system design, security model, IPC internals
- [Roadmap](docs/ROADMAP.md) — what's planned
- [Changelog](docs/CHANGELOG.md) — what's shipped
- [Security](SECURITY.md) — how to report vulnerabilities
- [Code of Conduct](CODE_OF_CONDUCT.md)

---

MIT License · Hosted on Cloudflare Pages · Made by [dipjyotimetia](https://github.com/dipjyotimetia)
