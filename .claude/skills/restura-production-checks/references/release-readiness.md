# Release / deploy readiness

`validate` proves the code is correct. These prove it _ships_. Run before a release tag or a deploy. Source: `package.json` scripts, `electron-builder.json`, `.github/workflows/release.yml`, `scripts/`.

## Builds (a type-clean change can still fail a build)

| Target             | Command                                                         | Failure modes                                                                                                                               |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Web + Worker       | `npm run build`                                                 | Cloudflare vite plugin emits SPA → `dist/web/client/`, Worker + `wrangler.json` → `dist/web/restura/`. `_worker.js` excluded from Electron. |
| Electron main      | `npm run electron:compile`                                      | `tsc -p electron/tsconfig.json` + `tsc-alias` + esbuild preload bundle. Preload must stay self-contained (sandboxed).                       |
| Electron full      | `npm run electron:pack` (dir) / `electron:dist:{mac,win,linux}` | ASAR layout, renderer entry.                                                                                                                |
| Docker / self-host | `npm run build:docker`                                          | esbuild `worker/node-entry.ts` → `dist/server/index.mjs`. `nodeEntry` must `Object.assign` onto `c.env`, not reassign.                      |

## Pre-release checklist

1. `npm run validate` clean (all six type-checks, lint, codegen, tests).
2. `npm run size` under budget (`size-limit`).
3. `npm run build` succeeds; web bundle present.
4. `npm run electron:pack` succeeds on at least the host OS; CI `electron-pack-smoke` covers the matrix.
5. `node scripts/verify-asar-renderer.mjs` passes — guards against `dist/web` layout drift breaking the packaged renderer entry.
6. Docs in parity (`references/docs-parity.md`), `npm run docs:check` clean.
7. `npm audit --audit-level=critical` clean (weekly CI is non-blocking — check it for a release).
8. Capability matrix current (`npm run capabilities:check`).

## Release workflow (`release.yml`, manual `workflow_dispatch`)

Inputs: `release_bump` (patch/minor/major), `prerelease`, `prerelease_identifier`, `publish_docker`. Flow: preflight validate → semver bump → commit + tag → release notes (git-cliff) → SBOM → fan-out: `desktop` (electron installers, all platforms), `publish-cli` (npm, stable only), `publish-docker` (GHCR, opt-in), `deploy-web` (Cloudflare, stable only).

- macOS builds are notarized (`docs/notary.md`); Sentry sourcemaps uploaded via `scripts/sentry-sourcemaps.mjs` on publish.
- CLI publishes from the `cli/` workspace; Docker from the repo Dockerfile.

## Deploy (outside release)

- `npm run deploy` — Worker (`api.restura.dev`) + Pages. Production requires `WORKER_PROXY_TOKEN` or `REQUIRE_CF_ACCESS=true`.
- `npm run deploy:docs` — docs-site → `restura-docs` Pages project.
- `npm run deploy:echo` — echo test upstream (not the product).
- **Never** put `DEV_BYPASS_AUTH` in `wrangler.jsonc` — it's a `.dev.vars`-only local bypass.
