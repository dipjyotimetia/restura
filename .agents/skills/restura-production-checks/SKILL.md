---
name: restura-production-checks
description: Use when verifying or maintaining Restura — before opening a PR, before merging, before a release or deploy, or whenever asking "is this production-ready", "did I miss a gate", "is this branch ready to ship", "what do I need to update", or "run the checks". The companion to restura-feature-dev (that one is for ADDING features; this one is for VERIFYING and MAINTAINING them). Encodes the non-obvious quality gates, the gaps in the local tooling, the security-test mapping, and the docs-parity ownership map that keep Restura production-grade.
---

# Restura production checks

`restura-feature-dev` tells you how to **add** a feature. This skill tells you how to **verify** it's production-ready and how to **keep the repo from rotting**. Most of what follows is non-obvious — it pushes against the assumptions the default tooling encourages.

The golden rule: **a green local `validate` is NOT the same as a green CI.** The gaps below are real and have shipped bugs.

## The gates, in order

Run `npm run validate` — `validate:static` (toolchain, tooling tests, `type-check:all`, lint, format, generated-type and capability-matrix freshness, `architecture:check`), `validate:test` (coverage tests, Electron critical coverage, workspace tests) and `validate:build` (web, size, Docker, workspaces, Electron). It does **not** run Playwright e2e or desktop e2e — see "What validate misses" below.

`/ship-check` runs the whole thing (including the parts `validate` skips) and triages failures. Reach for it before a PR.

## Top gotchas (the reason this skill exists)

1. **`npm run type-check` only covers the renderer.** The root `tsconfig.json` runs bare `tsc --noEmit` and **excludes `worker`, `electron/main`, and `cli`**. A clean `type-check` says nothing about whether the Electron main process, the Worker, the CLI, the echo server, or the http feature compiles. **Always use `npm run type-check:all`** — it runs every checked tsconfig project (renderer, tooling, electron, http feature, worker, echo, echo-local, cli, extension, vscode) the way CI does. This is chained into `validate`. If you see someone run plain `type-check` to "confirm it compiles," that's the trap.

2. **Commits are not type-checked.** `.husky/pre-commit` runs `guard-staged.mjs` and `lint-staged` (Biome on _staged_ files only). Only `.husky/pre-push` runs `type-check:related` (touched projects) and `architecture:check`. Type errors can land in commits; never treat "it committed cleanly" as "it type-checks." Run `type-check:all` yourself.

3. **Generated files must be regenerated, never hand-edited.** Two CI gates diff generated artifacts:
   - `verify:opencollection-types` regenerates `shared/opencollection/spec-types.ts` from `vendor/opencollection/.../schema.json` and fails on any diff. Edit the schema, then `npm run gen:opencollection-types`. `verify:postman-v3-types` and `verify:postman-v21-types` do the same for the Postman types.
   - `capabilities:check` regenerates `docs/CAPABILITY_MATRIX.md` from `src/lib/shared/capabilities.ts` and its per-area modules and fails on any diff. **Edit the area module under `src/lib/shared/capabilities/` (the source of truth), then `npm run capabilities:matrix`** — never the markdown.

4. **Capability parity is data-driven.** Any feature that behaves differently on web vs. desktop (e.g. Kafka, SOCKS/PAC/mTLS are desktop-only — no browser TCP) MUST add/update an entry in its area module under `src/lib/shared/capabilities/`. Forgetting this passes locally and fails `capabilities:check`.

5. **Coverage gates the test job.** `vitest.config.ts` uses an uncovered-item budget globally (newly added untested production code fails it) and percentage floors for `shared/protocol/**`. New code without tests fails even when every test passes. Add tests with the code.

6. **Commit messages** follow conventional commits. No local hook enforces them (`.husky/` has only `pre-commit` and `pre-push`).

## What `validate` misses (run these too when relevant)

- **e2e** (`npm run test:e2e`) — Playwright against the local dev server / echo upstream. Not in `validate`; CI runs a subset. Needs `.dev.vars` (bootstrapped by `e2e/global-setup.ts`).
- **Security suite** (`tests/security/*`) — these ARE part of `test:run`, but you should consciously confirm the right ones pass for your change. See `references/security-checklist.md`.
- **Packaged builds** — `electron:pack` / `electron:dist:*` and release signing. `validate:build` compiles but does not package, and a type-clean change can still fail packaging (ASAR layout). See `references/release-readiness.md`.
- **Docs parity** — nothing in `validate` checks that docs/ADRs/docs-site still match the code. See `references/docs-parity.md`.

## References (read on demand)

- **`references/verification-gates.md`** — every gate, the exact command, what it catches, and what it silently misses. The full map.
- **`references/security-checklist.md`** — change-type → which `tests/security/*` must pass. The Restura security invariants live in the `restura-security-auditor` agent (self-contained for isolated review); dispatch it for security-surface diffs.
- **`references/release-readiness.md`** — the pre-release / pre-deploy checklist: builds, bundle size, ASAR verification, multi-platform smoke, Sentry sourcemaps.
- **`references/docs-parity.md`** — the doc-ownership map (code surface → owning docs), the "does this need an ADR?" rubric, and why `docs:check` (just `astro check`) does not catch content drift. Pair with the `restura-docs-steward` agent.

## Companion tooling

- `/ship-check` — run the full gate + triage failures to file:line.
- `/docs-sync` — walk the doc-ownership map for a diff and update every stale surface.
- `restura-security-auditor` — review diffs to the SSRF/IPC/secret/sandbox surface.
- `restura-parity-checker` — review web/desktop wiring for a feature.
- `restura-docs-steward` — report which docs a diff made stale.
