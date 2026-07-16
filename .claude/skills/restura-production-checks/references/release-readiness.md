# Release / deploy readiness

`validate` is the coverage-aware local gate. These checks plus GitHub's
`merge-gate` prove the branch _ships_ across its supported surfaces. Run them
before a release tag or deploy. Source: `package.json` scripts,
`electron-builder.json`, `.github/workflows/{ci,release}.yml`, and `scripts/`.

## Builds (a type-clean change can still fail a build)

| Target             | Command                                                         | Failure modes                                                                                                                               |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Web + Worker       | `npm run build`                                                 | Cloudflare vite plugin emits SPA → `dist/web/client/`, Worker + `wrangler.json` → `dist/web/restura/`. `_worker.js` excluded from Electron. |
| Electron main      | `npm run electron:compile`                                      | `tsc -p electron/tsconfig.json` + `tsc-alias` + esbuild preload bundle. Preload must stay self-contained (sandboxed).                       |
| Electron full      | `npm run electron:pack` (dir) / `electron:dist:{mac,win,linux}` | ASAR layout, renderer entry.                                                                                                                |
| Docker / self-host | `npm run build:docker`                                          | esbuild `worker/node-entry.ts` → `dist/server/index.mjs`. `nodeEntry` must `Object.assign` onto `c.env`, not reassign.                      |

## Pre-release checklist

1. `npm run validate` clean (all TypeScript projects, Biome, codegen, root coverage, CLI tests).
2. `npm run size` under budget (`size-limit`).
3. `npm run build` succeeds; web bundle present.
4. `npm run build:docker` succeeds and the self-hosted server answers `/health`.
5. `npm run electron:pack` succeeds on at least the host OS; CI `electron-smoke` covers the cross-OS matrix.
6. `node scripts/verify-asar-renderer.mjs` passes — guards against `dist/web` layout drift breaking the packaged renderer entry.
7. Docs in parity (`references/docs-parity.md`), `npm run docs:check` clean.
8. `npm audit --audit-level=critical` clean (weekly CI is non-blocking — check it for a release).
9. Capability matrix current (`npm run capabilities:check`).
10. A trusted GitHub Actions `merge-gate` from this repository's CI workflow on a `main` push is green for the exact candidate SHA.

## Release workflow (`release.yml`)

Inputs: `release_bump` (patch/minor/major), `prerelease`,
`prerelease_identifier`, `publish_docker`, plus recovery/repair inputs. A manual
stable dispatch opens and merges a trusted version-only PR; its close event
resumes publication. Preflight resolves one candidate SHA, verifies its trusted
CI proof, and propagates that SHA through tag verification, notes/SBOM, and the
desktop, CLI, Docker, and web fan-out.

- macOS builds are notarized (`docs/notary.md`); Sentry sourcemaps uploaded via `scripts/sentry-sourcemaps.mjs` on publish.
- CLI publishes from the `cli/` workspace; Docker from the repo Dockerfile.

## Deploy (outside release)

- `npm run deploy` — Worker (`api.restura.dev`) + Pages. Production requires `WORKER_PROXY_TOKEN` or `REQUIRE_CF_ACCESS=true`.
- `npm run deploy:docs` — docs-site → `restura-docs` Pages project.
- `npm run deploy:echo` — echo test upstream (not the product).
- **Never** put `DEV_BYPASS_AUTH` in `wrangler.jsonc` — it's a `.dev.vars`-only local bypass.
