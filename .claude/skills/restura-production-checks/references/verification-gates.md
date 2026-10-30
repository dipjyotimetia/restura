# Verification gates — full map

Every gate, the exact command, what it catches, and what it silently misses. Source of truth: `package.json` scripts and `.github/workflows/ci.yml`.

## The `validate` chain (CI `validate` job)

`npm run validate` = `validate:static` (toolchain, tooling tests, `type-check:all`, lint, format, generated-type and capability freshness, `architecture:check`) → `validate:test` (coverage tests, Electron critical coverage, workspace tests) → `validate:build` (web, size, Docker, workspaces, Electron). The table below lists the main gates it contains.

| Step                       | Command                               | Catches                                                                                                     | Misses                                                                           |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Type-check (all)           | `npm run type-check:all`              | Type errors across every checked tsconfig project                                                           | Runtime bugs; lint-only rules                                                    |
| Type-check (renderer only) | `npm run type-check`                  | Renderer/shared type errors                                                                                 | **Worker, electron/main, cli, echo, http feature** — root tsconfig excludes them |
| Lint                       | `npm run lint`                        | `src shared electron/main worker echo echo-local cli extension/* tests scripts` — style, `no-explicit-any` (error), unused vars, type-imports       | Renderer-only react-hooks rules apply only under `src/`                          |
| OpenCollection types       | `npm run verify:opencollection-types` | Stale `shared/opencollection/spec-types.ts` vs schema                                                      | n/a                                                                              |
| Capability matrix          | `npm run capabilities:check`          | Stale `docs/CAPABILITY_MATRIX.md` vs `capabilities.ts`                                                      | Whether the capability value is _correct_ — only checks freshness                |
| Unit/integration tests     | `npm run test:run`                    | Vitest across `src/`, `tests/`, `electron/main/__tests__`, `worker`, `echo`, `shared` + coverage thresholds | Anything not covered; e2e flows                                                  |

## The type-check projects (what `type-check:all` runs)

```
npm run type-check                                    # renderer + shared (root tsconfig.json)
npm run type-check:tooling                            # tooling ratchets
tsc --noEmit -p electron/tsconfig.json                # Electron main process
tsc --noEmit -p src/features/http/tsconfig.json       # http feature project
tsc --noEmit -p worker/tsconfig.json                  # Cloudflare Worker
tsc --noEmit -p echo/tsconfig.json                    # echo test server
tsc --noEmit -p echo-local/tsconfig.json              # local echo stack
npm run --workspace cli type-check                    # restura-cli workspace
npm run --workspace @restura/extension type-check     # browser extension
npm run --workspace restura-vscode type-check         # VS Code extension
```

Root `tsconfig.json` `exclude` = `node_modules, dist, out, worker, electron/main, cli, docs-site`. That exclusion is the whole reason `type-check:all` exists.

## Gates NOT in `validate` (run consciously)

| Gate             | Command                               | When                                                                                                  |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| e2e              | `npm run test:e2e` (`:ui`, `:headed`) | Protocol/UI flows; needs `.dev.vars`. `workers:1`, not parallel.                                      |
| Contract         | `npm run test:contract`               | Cross-fetcher HTTP parity (`tests/contract/`) — also runs under `test:run` glob, but this targets it. |
| Docs site        | `npm run docs:check` (`astro check`)  | docs-site edits — **links/types only, not content parity**                                            |
| Codegen (proto)  | `npm run proto:gen`                   | `.proto` changes under `e2e/mocks/proto/`                                                             |

## CI jobs (`.github/workflows/ci.yml`)

- `validate` — runs the type-checks as separate steps, then lint, generated-code verification, `test:ci` (coverage), build (renderer + electron compile), bundle size.
- `electron-pack-smoke` — matrix build on macOS/Windows/Ubuntu (PRs only).
- Separate workflows: `security-audit.yml` (weekly `npm audit --audit-level=critical`, non-blocking), `dependency-review.yml` (PR license/severity gate).

## Fast triage when a gate fails

- `type-check:all` fails but `type-check` passes → the error is in worker / electron-main / cli / echo / http — look there, not the renderer.
- `capabilities:check` fails → you changed behavior without updating the area module under `src/lib/shared/capabilities/`, or you edited the matrix by hand. Run `npm run capabilities:matrix`.
- `verify:opencollection-types` fails → run `npm run gen:opencollection-types` and commit the result.
- Coverage budget fails → add tests; check `vitest.config.ts` exclusions before assuming the file is untestable.
