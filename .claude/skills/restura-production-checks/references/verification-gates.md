# Verification gates — full map

Every gate, the exact command, what it catches, and what it silently misses. Source of truth: `package.json` scripts and `.github/workflows/ci.yml`.

## The `validate` chain (CI `validate` job)

`npm run validate` = `type-check:all` → `lint` → `verify:opencollection-types` → `capabilities:check` → `test:run`.

| Step                       | Command                               | Catches                                                                                                     | Misses                                                                           |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Type-check (all)           | `npm run type-check:all`              | Type errors across all 6 tsconfig projects                                                                  | Runtime bugs; lint-only rules                                                    |
| Type-check (renderer only) | `npm run type-check`                  | Renderer/shared type errors                                                                                 | **Worker, electron/main, cli, echo, http feature** — root tsconfig excludes them |
| Lint                       | `npm run lint`                        | `src electron/main worker echo scripts` — style, `no-explicit-any` (error), unused vars, type-imports       | Renderer-only react-hooks rules apply only under `src/`                          |
| OpenCollection types       | `npm run verify:opencollection-types` | Stale `src/lib/opencollection/spec-types.ts` vs schema                                                      | n/a                                                                              |
| Capability matrix          | `npm run capabilities:check`          | Stale `docs/CAPABILITY_MATRIX.md` vs `capabilities.ts`                                                      | Whether the capability value is _correct_ — only checks freshness                |
| Unit/integration tests     | `npm run test:run`                    | Vitest across `src/`, `tests/`, `electron/main/__tests__`, `worker`, `echo`, `shared` + coverage thresholds | Anything not covered; e2e flows                                                  |

## The six type-check projects (what `type-check:all` runs)

```
npm run type-check                                    # renderer + shared (root tsconfig.json)
tsc --noEmit -p electron/tsconfig.json                # Electron main process
tsc --noEmit -p src/features/http/tsconfig.json       # http feature project
tsc --noEmit -p worker/tsconfig.json                  # Cloudflare Worker
tsc --noEmit -p echo/tsconfig.json                    # echo test server
npm run --workspace cli type-check                    # @restura/cli workspace
```

Root `tsconfig.json` `exclude` = `node_modules, dist, out, worker, electron/main, cli, docs-site`. That exclusion is the whole reason `type-check:all` exists.

## Gates NOT in `validate` (run consciously)

| Gate             | Command                               | When                                                                                                  |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| e2e              | `npm run test:e2e` (`:ui`, `:headed`) | Protocol/UI flows; needs `.dev.vars`. `workers:1`, not parallel.                                      |
| Contract         | `npm run test:contract`               | Cross-fetcher HTTP parity (`tests/contract/`) — also runs under `test:run` glob, but this targets it. |
| Web build        | `npm run build`                       | Bundle/Worker layout changes                                                                          |
| Electron compile | `npm run electron:compile`            | Anything in `electron/main` (preload bundling, tsc-alias)                                             |
| Docker build     | `npm run build:docker`                | `worker/node-entry.ts`, self-host changes                                                             |
| Bundle size      | `npm run size`                        | Adding deps / large modules                                                                           |
| Docs site        | `npm run docs:check` (`astro check`)  | docs-site edits — **links/types only, not content parity**                                            |
| Codegen (proto)  | `npm run proto:gen`                   | `.proto` changes under `e2e/mocks/proto/`                                                             |

## CI jobs (`.github/workflows/ci.yml`)

- `validate` — runs the six type-checks as separate steps, then lint, generated-code verification, `test:ci` (coverage), build (renderer + electron compile), bundle size.
- `electron-pack-smoke` — matrix build on macOS/Windows/Ubuntu (PRs only).
- Separate workflows: `security-audit.yml` (weekly `npm audit --audit-level=critical`, non-blocking), `dependency-review.yml` (PR license/severity gate).

## Fast triage when a gate fails

- `type-check:all` fails but `type-check` passes → the error is in worker / electron-main / cli / echo / http — look there, not the renderer.
- `capabilities:check` fails → you changed behavior without updating `src/lib/shared/capabilities.ts`, or you edited the matrix by hand. Run `npm run capabilities:matrix`.
- `verify:opencollection-types` fails → run `npm run gen:opencollection-types` and commit the result.
- Coverage threshold fails → add tests; check `vitest.config.ts` exclusions before assuming the file is untestable.
- `commit-msg` fails → scope not in the enum, or subject/body format. See the enum in the SKILL.
