# Operations

How Restura is built, run, tested, packaged, and deployed. Use this page to onboard a new environment, diagnose CI failures, or understand the release pipeline.

---

## Development setup

Requirements:

- Node.js 24+ (managed via `.nvmrc`).
- npm.
- Docker (optional — used for self-hosting, local Kafka/MQTT brokers, some e2e tests).

Install:

```bash
npm ci
```

Create local environment files from examples (do not commit secrets):

```bash
cp .env.example .env
cp .dev.vars.example .dev.vars
```

### Start the dev server

```bash
npm run dev
```

Starts Vite on port 5173 and boots the Cloudflare Worker via Miniflare.

### Common development commands

```bash
# Web / SPA
npm run dev
npm run build
npm run preview

# Type-check / lint / format
npm run type-check                  # renderer only — trap!
npm run type-check:all              # renderer + Electron + Worker + CLI + extensions
npm run lint
npm run format
npm run format:check

# Testing
npm run test                        # Vitest interactive
npm run test:run                    # single run
npm run test:contract               # parity contract tests
npm run test:coverage
npm run test:e2e                    # Playwright web
npm run test:e2e:electron         # Playwright Electron (needs build)

# Electron
npm run electron:dev
npm run electron:build:web
npm run electron:compile
npm run electron:dist:{mac,win,linux}

# Self-hosted
npm run build:docker
npm run start                       # node dist/server/index.mjs

# Coverage-aware local shipping gate
npm run validate                    # type-check:all + lint + format + codegen verify + coverage + CLI test
```

> **Trap:** plain `npm run type-check` only covers the renderer. Use `npm run type-check:all`; pre-commit hooks run only `lint-staged`, not tsc or tests.

---

## Targets

### Web (Cloudflare Pages + Workers)

- `npm run build` → `dist/web/`.
- `worker/index.ts` — Cloudflare Pages Function entry.
- API routes through `worker/handlers/*.ts` and the shared Hono app.
- Web limitations: no SOCKS/PAC, no mTLS/custom CA, no OS keychain, no Kafka/MQTT, no AI, no file/Git collections, no mock server.

### Self-hosted (Node / Docker)

- `npm run build:docker` → SPA `dist/web` + server `dist/server/index.mjs`.
- `npm run start` runs `dist/server/index.mjs`.
- Same Hono factory in `worker/app.ts` with Node adapters in `worker/shared/*` and `worker/handlers/websocket-node.ts`.
- Stateless: data remains in browser IndexedDB.
- Requires `WORKER_PROXY_TOKEN` for proxy routes; local dev bypass needs `ENVIRONMENT=development` **and** `DEV_BYPASS_AUTH=true`.
- See `docs/SELF_HOSTING.md`.

### Electron desktop

- `npm run electron:dev` — local dev with hot reload.
- `npm run electron:build:web` — renderer with `VITE_IS_ELECTRON_BUILD=true`.
- `npm run electron:compile` — compile main process TS.
- `npm run electron:dist:{mac,win,linux}` — package distributables.
- Native IPC handlers: `electron/main/handlers/*-handler.ts`.
- Auto-updates via `electron-updater`; signing/notarization on macOS in `docs/notary.md` and `electron-builder.json`.

---

## CLI

`restura run` is a standalone Node CLI for CI collection execution.

- Entry: `cli/src/index.ts`
- Run command: `cli/src/commands/run.ts`
- Runner: `cli/src/runner/runner.ts`
- Executors: `cli/src/runner/executors/*.ts`
- Fetch: `cli/src/runner/undiciFetcher.ts`
- Scripts: `cli/src/runner/scriptRunner.ts`
- Reporters: `cli/src/reporters/*.ts`

> Secret handles cannot be resolved in CI; the CLI throws instead of sending unauthenticated requests.

Run CLI tests: `npm run --workspace cli test`.

---

## Testing

### Vitest unit/integration tests

- Entry config: `vitest.config.ts`.
- `src/**/*.test.ts` — co-located tests.
- `shared/protocol/*.test.ts` — protocol core tests.
- `electron/main/__tests__/**` — Electron handler tests.
- `worker/__tests__/**` — Worker / Node server tests.
- `tests/**` — top-level integration, contract, parity, and security tests.

Useful commands:

```bash
vitest run path/to/file.test.ts
vitest run -t "test name pattern"
```

### Playwright e2e

- Web e2e: `playwright.config.ts` at repo root; specs in `e2e/`.
- Electron e2e: `e2e-electron/playwright.config.ts`; specs in `e2e-electron/`.
- `.dev.vars` must be present for web e2e because `webServer` boots the worker.
- Electron e2e uses native gRPC dev server (`npm run grpc:server`) and Dockerized Kafka/MQTT brokers for protocol tests; specs auto-skip Docker-dependent tests if Docker is unavailable.

### CI gates

The coverage-aware local `validate` gate runs:

1. `type-check:all`
2. `lint`
3. `format:check`
4. `verify:opencollection-types` — regenerates OpenCollection types and fails on diff.
5. `capabilities:check` — regenerates capability matrix and fails on diff.
6. `test:ci` — the full Vitest suite with global uncovered-item budgets and
   stronger `shared/protocol/**` percentage thresholds.
7. CLI workspace test.

The GitHub `merge-gate` is the full CI verdict. It additionally aggregates the
self-hosted image build and API/SPA smoke, docs, browser and Electron E2E, browser
and VS Code extension E2E, and cross-OS Electron packaging. There are also
codegen ownership checks and bundle-size limits (`size-limit`).

---

## Builds and generated files

- `npm run proto:gen` — `buf generate`; regenerates TypeScript protobuf code.
- `npm run gen:opencollection-types` — generates `src/lib/opencollection/spec-types.ts` from the vendored schema.
- `npm run capabilities:matrix` — generates `docs/CAPABILITY_MATRIX.md` from `src/lib/shared/capabilities.ts`.
- `npm run build:sandbox-libs` — rebuilds QuickJS sandbox libraries.

Do not edit generated files by hand; CI will fail the drift checks.

---

## Telemetry and privacy

- Telemetry is off by default until `settings.telemetry.errorsEnabled` is true.
- Desktop errors are sent to Sentry via a renderer→main IPC bridge; `sendDefaultPii: false`; secrets are redacted.
- Web errors are POSTed to `/api/telemetry/error` on the same Worker/self-hosted instance — no third-party telemetry service.
- Self-hosted server collects no application-level usage analytics.
- Release Health (desktop only) contributes anonymous session counts for crash-free rate and version adoption.
- Details in `docs/adr/0027-telemetry-and-privacy-preserving-usage-analytics.md` and `electron/main/lifecycle/sentry.ts`.

Avoid logging request URLs, headers, bodies, file paths, or PII in error handlers.

---

## CI/CD and release

Source of truth for workflows is `.github/workflows/`. Key documents:

- `docs/CI_CD.md` — full pipeline, required status checks, branch protection, supply-chain security.
- `docs/DISTRIBUTION.md` — desktop app signing, notarization, distribution.
- `docs/EXTENSION_RELEASE.md` — Chrome/VS Code extension release runbook.

Important rules:

- `npm run validate` is the deterministic local gate; the GitHub `merge-gate`
  is the complete shipping verdict across the self-host image/API/SPA, docs, web/Electron
  E2E, extensions, and cross-OS packaging.
- Release preflight requires that `merge-gate` succeeded for the exact release
  candidate commit before any publication job starts.
- Ordinary merges do not cut releases. A manual dispatch starts the stable
  flow; its trusted version-only PR-close event resumes exact-candidate publication.
- CLI provenance is published via `npm publish --provenance`.
- Desktop and image provenance use `actions/attest-build-provenance` and can be verified with `gh attestation verify`.
- SBOMs are generated with `@cyclonedx/cyclonedx-npm` and attached to releases.

---

## Troubleshooting

| Symptom                              | Likely cause                           | Fix                                                                                  |
| ------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `type-check` passes but CI fails     | Only type-checked renderer             | Use `npm run type-check:all`                                                         |
| Pre-commit passed but CI test fails  | Pre-commit does not run tests          | Run `npm run test:run` before push                                                   |
| Capability matrix diff in CI         | Forgot to regenerate                   | `npm run capabilities:matrix`                                                        |
| OpenCollection types diff in CI      | Schema or generator changed            | `npm run gen:opencollection-types`                                                   |
| WebSocket custom headers fail on web | Browser WS API limitation              | Web uses `/api/ws-ticket` flow; desktop native `ws` ok                               |
| Web data is not encrypted at rest    | Web currently uses plaintext IndexedDB | Use Electron for OS-keychain-backed encryption; the web passphrase UI is not shipped |
| Electron build huge                  | Worker bundle included                 | Check `electron-builder.json` excludes `_worker.js`                                  |

---

## Source map

| Concern            | Files                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Root build config  | `vite.config.mts`, `tsconfig*.json`, `package.json`                                                               |
| Electron build     | `electron-builder.json`, `electron/tsconfig.json`, `scripts/clean-electron-dist.mjs`, `scripts/generate-icons.js` |
| Worker app factory | `worker/app.ts`, `worker/adapters.ts`, `worker/env.ts`                                                            |
| Worker entries     | `worker/index.ts` (Cloudflare), `worker/node-entry.ts` (Node/Docker)                                              |
| CLI                | `cli/src/index.ts`, `cli/src/runner/runner.ts`                                                                    |
| Test config        | `vitest.config.ts`, `playwright.config.ts`, `e2e-electron/playwright.config.ts`                                   |
| Telemetry          | `electron/main/lifecycle/sentry.ts`, `worker/handlers/telemetry.ts`, `src/lib/shared/telemetry.ts`                |
| CI workflows       | `.github/workflows/*.yml`                                                                                         |
| Capability matrix  | `src/lib/shared/capabilities.ts`, `scripts/generate-capability-matrix.mjs`                                        |

---

## Related docs

- [Development Standards](https://github.com/dipjyotimetia/restura/blob/main/docs/DEVELOPMENT_STANDARDS.md)
- [Self Hosting](https://github.com/dipjyotimetia/restura/blob/main/docs/SELF_HOSTING.md)
- [Distribution](https://github.com/dipjyotimetia/restura/blob/main/docs/DISTRIBUTION.md)
- [CI/CD](https://github.com/dipjyotimetia/restura/blob/main/docs/CI_CD.md)
- [Security](https://github.com/dipjyotimetia/restura/blob/main/docs/security.md)
