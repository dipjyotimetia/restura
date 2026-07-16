# Restura — OpenWiki quickstart

Restura is a multi-protocol API client that speaks HTTP/REST, GraphQL, gRPC, WebSocket, Socket.IO, Server-Sent Events (SSE), Kafka, MQTT, and MCP. It is privacy-first: data is stored locally by default with no accounts or cloud sync required. The project ships a single React SPA to three targets: a **web app** (Cloudflare Pages + Workers), a **self-hosted Node/Docker server**, and an **Electron desktop app** for macOS, Windows, and Linux.

This wiki is an in-repo map for humans and future coding agents. It links out to the existing docs site (`docs-site/` and `docs/`) where they are authoritative, and focuses on architecture, code layout, workflows, and operational guidance.

---

## What to read first

| If you want to...                                                   | Start here                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Run the app, type-check, test, or build                             | [Operations — Development setup](operations/index.md#development-setup) |
| Understand the renderer/backends/shared protocol layer              | [Architecture overview](architecture/overview.md)                       |
| Work on a protocol feature (HTTP, gRPC, WS, SSE, MCP, AI)           | [Protocol features](features/protocols.md)                              |
| Work on workflows, Flow, or collection batch runners                | [Workflows](workflows/index.md)                                         |
| Work on scripts, variables, environments, secrets, or persistence   | [Scripts, variables & storage](features/scripts-variables-storage.md)   |
| Import/export, OpenCollection, Postman parity, file/Git collections | [Integrations](integrations/index.md)                                   |
| CI/CD, Docker self-host, packaging, telemetry, security             | [Operations](operations/index.md)                                       |
| Test strategy, e2e, contract and security tests                     | [Testing](testing/index.md)                                             |

The repo also maintains `/CLAUDE.md` (Claude Code) and `/AGENTS.md` (Codex) as concise agent handbooks. This wiki is the deeper navigation layer.

---

## Repository overview

```
/                          # root monorepo with npm workspaces (cli, chrome + vscode extensions)
├─ src/                    # React SPA renderer shared by web, self-hosted, and Electron
├─ shared/                 # Backend-agnostic protocol orchestrators and capture helpers
├─ worker/                 # Cloudflare Worker + self-hosted Node backend (Hono app factory)
├─ electron/               # Desktop shell: main process, preload, IPC handlers, storage
├─ cli/                    # CI `restura` CLI (npm workspace)
├─ extension/              # Browser capture extension workspaces
├─ echo/                   # Echo test Worker
├─ echo-local/             # Local multi-protocol echo server for desktop tests
├─ docs/                   # Markdown design docs, ADRs, runbooks, security
├─ docs-site/              # Astro public docs site
└─ tests/                  # Vitest/Playwright tests, contract tests
```

### Key source roots

- `src/main.tsx`, `src/App.tsx`, `src/routes/index.tsx` — renderer entry, hash router, workspace shell.
- `src/features/<protocol>/` — per-protocol UI and logic. Each protocol feature exports a `protocol.ts` describing its schema and executor.
- `src/features/registry/` — protocol registry. `bootstrap.ts` registers modules; `useRequestRunner.ts` is the single entry point.
- `shared/protocol/` — backend-agnostic HTTP/gRPC/MCP/WebSocket/SSE/AI orchestrators, validation, body building, auth signing.
- `worker/app.ts` — `createApp(deps)` Hono factory. `worker/index.ts` runs it under Cloudflare; `worker/node-entry.ts` runs it as a Node/Docker server.
- `electron/main/` — IPC handlers, protocol native handling, storage, telemetry, window management.
- `src/store/` and `src/features/*/store.ts` — Zustand stores; many are persisted via Dexie (web) or encrypted electron-store (desktop).
- `src/lib/shared/` — platform detection, encryption, variable scopes, validators, capabilities, persistence adapters.

---

## Common development commands

```bash
# Web / SPA development
npm run dev                         # Vite on :5173 + Worker via Miniflare
npm run build                       # SPA + Worker production bundle
npm run preview                     # Preview production build

# Type-check / lint / format
npm run type-check                  # renderer-only (not Worker/Electron/CLI)
npm run type-check:all              # all tsconfig projects (CI)
npm run lint
npm run format

# Vitest
npm run test                        # interactive
npm run test:run                    # single run
npm run test:contract               # contract tests

# Playwright e2e
npm run test:e2e                    # web dev server
npm run test:e2e:electron         # desktop against unpacked build

# Electron dev
npm run electron:dev                # Vite + Electron with wait-on
npm run electron:build:web          # Build renderer for Electron
npm run electron:compile          # Compile main process TS to dist/electron/
npm run electron:dist:mac         # Package macOS app

# Self-hosted
npm run build:docker                # SPA -> dist/web + server -> dist/server/index.mjs
npm run start                       # node dist/server/index.mjs

# CLI
npm run --workspace cli test

# Coverage-aware local shipping validation
npm run validate                    # type-check:all -> lint -> fmt -> codegen checks -> coverage -> CLI tests

# Complete GitHub CI verdict
# merge-gate also requires the shipped self-host image/API/SPA, docs, e2e, extensions, and packaging
```

**Traps for agents**

- `npm run type-check` only covers the renderer. Use `npm run type-check:all` for the same coverage CI uses.
- The pre-commit hook runs only `lint-staged` (Biome lint + format). It does not run tests or tsc.
- Generated code is CI-gated: `npm run verify:opencollection-types` and `npm run capabilities:check` can fail if source-of-truth files changed but outputs were not regenerated.
- A local `npm run validate` pass is necessary but not the complete shipping
  verdict; GitHub's `merge-gate` aggregates every required platform job,
  including the shipped self-hosted image, `/health`, and bundled SPA.
- Adding a protocol? Put backend-agnostic logic in `shared/protocol/` and add a thin `Fetcher` adapter in `worker/handlers/` and `electron/main/handlers/`.

---

## Documentation sections

- [Architecture overview](architecture/overview.md) — renderer, backends, shared protocol layer, Fetcher pattern.
- [Protocol features](features/protocols.md) — registry, request types, streaming vs execution, per-protocol notes.
- [Workflows](workflows/index.md) — linear and DAG execution, Flow canvas, validators, collection runner.
- [Scripts, variables & storage](features/scripts-variables-storage.md) — QuickJS sandbox, variable scopes, persistence, secrets.
- [AI and MCP](features/ai-mcp.md) — AI chat, AI Lab eval workbench, Restura-as-MCP-server, MCP client.
- [Integrations](integrations/index.md) — import/export, OpenCollection, Postman parity, file/Git collections.
- [Operations](operations/index.md) — CLI, CI/CD, Docker, telemetry, security.
- [Testing](testing/index.md) — test pyramid, e2e, contract, parity, and security tests.
