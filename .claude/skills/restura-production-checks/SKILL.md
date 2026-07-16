---
name: restura-production-checks
description: Use when verifying or maintaining Restura — before opening a PR, before merging, before a release or deploy, or whenever asking "is this production-ready", "did I miss a gate", "is this branch ready to ship", "what do I need to update", or "run the checks". The companion to restura-feature-dev (that one is for ADDING features; this one is for VERIFYING and MAINTAINING them). Encodes the non-obvious quality gates, the gaps in the local tooling, the security-test mapping, and the docs-parity ownership map that keep Restura production-grade.
---

# Restura production checks

`restura-feature-dev` tells you how to **add** a feature. This skill tells you how to **verify** it's production-ready and how to **keep the repo from rotting**. Most of what follows is non-obvious — it pushes against the assumptions the default tooling encourages.

The golden rule: **a green local `validate` is NOT the same as a green CI.** The gaps below are real and have shipped bugs.

## The gates, in order

Run `npm run validate` — it chains `type-check:all` → `lint` → `format:check` → `verify:opencollection-types` → `capabilities:check` → `test:ci` → CLI tests and records content-bound evidence for the Codex stop policy. It is the coverage-aware local gate, not the complete CI verdict. GitHub's `merge-gate` also requires the shipped self-hosted image/API/SPA smoke and the platform, extension, documentation, and packaging jobs below.

`/ship-check` runs the whole thing (including the parts `validate` skips) and triages failures. Reach for it before a PR.

## Top gotchas (the reason this skill exists)

1. **`npm run type-check` only covers the renderer.** The root `tsconfig.json` runs bare `tsc --noEmit` and excludes the Worker, Electron main process, CLI, echo servers, HTTP project, and extensions. **Always use `npm run type-check:all`** — it covers every TypeScript project used by CI and is chained into `validate`.

2. **The pre-commit hook skips tsc entirely.** `.husky/pre-commit` runs `lint-staged` (Biome check on _staged_ files only). No type-check, no tests. **Type errors land in commits routinely.** Never treat "it committed cleanly" as "it type-checks." Run `type-check:all` yourself.

3. **Generated files must be regenerated, never hand-edited.** Two CI gates diff generated artifacts:
   - `verify:opencollection-types` regenerates `src/lib/opencollection/spec-types.ts` from `vendor/opencollection/.../schema.json` and fails on any diff. Edit the schema, then `npm run gen:opencollection-types`.
   - `capabilities:check` regenerates `docs/CAPABILITY_MATRIX.md` from `src/lib/shared/capabilities.ts` and fails on any diff. **Edit `capabilities.ts` (the source of truth), then `npm run capabilities:matrix`** — never the markdown.

4. **Capability parity is data-driven.** Any feature that behaves differently on web vs. desktop (e.g. Kafka, SOCKS/PAC/mTLS are desktop-only — no browser TCP) MUST add/update an entry in `src/lib/shared/capabilities.ts`. Forgetting this passes locally and fails `capabilities:check`.

5. **Coverage budgets gate the test job.** The global suite fails when uncovered items exceed the checked-in budgets (currently 5,226 branches, 4,378 lines, 1,344 functions, and 5,321 statements); `shared/protocol/**` also retains stronger percentage thresholds. New untested production code can fail even when every assertion passes.

6. **Commit messages are linted.** `commitlint.config.mjs` enforces conventional commits with a fixed `scope-enum` (ai, auth, cli, ci, collections, console, deps, docs, e2e, electron, graphql, grpc, http, kafka, mcp, release, scripts, security, shared, socketio, sse, tests, ui, websocket, worker, workflows). A scope outside that list fails `commit-msg`. `body-max-line-length` is 200.

## What `validate` misses (run these too when relevant)

- **e2e** (`npm run test:e2e`) — Playwright against the local dev server / echo upstream. Not in `validate`; CI runs a subset. Needs `.dev.vars` (bootstrapped by `e2e/global-setup.ts`).
- **Security suite** (`tests/security/*`) — these are part of `test:ci`, but consciously confirm the mapped boundary tests for your change. See `references/security-checklist.md`.
- **Builds** — `npm run build` (web+Worker), `npm run electron:compile`, `npm run build:docker`. A type-clean change can still fail a build (bundle layout, ASAR). See `references/release-readiness.md`.
- **Bundle size** — `npm run size` (`size-limit`). Gated in CI.
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
