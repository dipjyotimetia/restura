---
description: Run Restura's full production-grade gate (everything `npm run validate` covers plus what it misses) and triage failures to file:line.
argument-hint: '[--quick | --full] (default: scope to the current diff)'
allowed-tools: Bash, Read, Grep, Glob, Task
---

You are running the Restura ship-readiness gate. First invoke the `restura-production-checks` skill so its gotchas are loaded. Then execute the gates below, collect results, and produce ONE consolidated checklist. Do not stop at the first failure — run everything, then report.

Scope: `$ARGUMENTS`. If `--quick`, skip builds, e2e, and bundle size. If `--full`, include them. Default: run the core gate + builds, skip e2e unless the diff touches protocol/transport code.

Determine the diff under review: `git diff --stat main...HEAD` and `git status --porcelain`.

## Gates (run all; capture pass/fail + output)

1. **Type-check (all six projects)** — `npm run type-check:all`. NOTE: plain `type-check` only covers the renderer; this is the real gate. If it fails but renderer is clean, the error is in worker/electron-main/cli/echo/http.
2. **Lint** — `npm run lint`.
3. **Codegen freshness** — `npm run verify:opencollection-types` and `npm run capabilities:check`. On failure, the fix is to regenerate (`gen:opencollection-types` / `capabilities:matrix`), not hand-edit.
4. **Unit/integration + coverage** — `npm run test:run`.
5. **Security suite** — if the diff touches `shared/protocol/`, `electron/main/*-guard.ts`, `dns-guard.ts`, `ipc-validators.ts`, secret stores, or sandboxes: confirm the relevant `tests/security/*` passed in step 4, and dispatch the `restura-security-auditor` agent on the diff.
6. **Parity** — if the diff adds/changes a protocol or networked feature: dispatch the `restura-parity-checker` agent.
7. **Docs parity** — run `npm run docs:check`, then dispatch the `restura-docs-steward` agent on the diff (CI has no content-parity gate).
8. **Builds** (unless `--quick`) — `npm run build` and `npm run electron:compile`.
9. **Bundle size** (only `--full`) — `npm run size`.
10. **e2e** (only `--full`, or if protocol/transport changed) — `npm run test:e2e`.

## Output

Produce a checklist. For each gate: ✅/❌ and a one-line result. For every failure, give the `file:line` (parsed from the tool output) and the minimal fix. End with a verdict: **READY** (all green) or **NOT READY** (list the blocking items). If there are failures, offer to fix them — start with type-check and codegen, which are usually mechanical.

```
## Ship-check — <branch>
| Gate | Result |
|------|--------|
| type-check:all | ✅ / ❌ <first error file:line> |
| lint | … |
| codegen freshness | … |
| tests + coverage | … |
| security audit | … |
| parity | … |
| docs parity | … |
| build | … |
Verdict: READY / NOT READY — <blockers>
```
