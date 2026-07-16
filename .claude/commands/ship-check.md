---
description: Run Restura's full production-grade gate (everything `npm run validate` covers plus what it misses) and triage failures to file:line.
argument-hint: '[--quick | --full] (default: scope to the current diff)'
allowed-tools: Bash, Read, Grep, Glob, Task
---

You are running the Restura ship-readiness gate. First invoke the `restura-production-checks` skill so its gotchas are loaded. Then execute the gates below, collect results, and produce ONE consolidated checklist. Do not stop at the first failure — run everything, then report.

Scope: `$ARGUMENTS`. If `--quick`, skip builds, e2e, and bundle size. If `--full`, include them. Default: run the core gate + builds, skip e2e unless the diff touches protocol/transport code.

Determine the diff under review: `git diff --stat main...HEAD` and `git status --porcelain`.

## Gates (run all; capture pass/fail + output)

1. **Type-check (all projects)** — `npm run type-check:all`. NOTE: plain `type-check` only covers the renderer; the aggregate command also covers Worker, Electron, CLI, echo, HTTP, and extension projects.
2. **Lint** — `npm run lint`.
3. **Codegen freshness** — `npm run verify:opencollection-types` and `npm run capabilities:check`. On failure, the fix is to regenerate (`gen:opencollection-types` / `capabilities:matrix`), not hand-edit.
4. **Unit/integration + coverage** — `npm run test:ci` (normally through `npm run validate`).
5. **Agent review fan-out** — dispatch every applicable reviewer **in parallel** (one message, multiple Task calls — they are independent; serializing them wastes the wall-clock of every faster agent):
   - `restura-security-auditor` — if the diff touches `shared/protocol/`, `electron/main/*-guard.ts`, `dns-guard.ts`, `ipc-validators.ts`, secret stores, or sandboxes. Also confirm the relevant `tests/security/*` passed in step 4.
   - `restura-parity-checker` — if the diff adds/changes a protocol or networked feature.
   - `restura-docs-steward` — always (CI has no content-parity gate). Run `npm run docs:check` alongside it.
   - **Fresh-context code review** — for any non-trivial diff, also run the built-in `/code-review` skill. A reviewer that did not write the code is not influenced by the authoring session's reasoning; the agents above check domain properties, this one checks correctness.
6. **Builds** (unless `--quick`) — `npm run build`, `npm run build:docker`, and `npm run electron:compile`. Start these as **background Bash** in the same message as the agent dispatch so they overlap the fan-out — running them afterwards serializes the slowest gates.
7. **Bundle size** (only `--full`) — `npm run size`.
8. **e2e** (only `--full`, or if protocol/transport changed) — `npm run test:e2e`.
9. **Complete CI verdict** — local commands do not replace the GitHub `merge-gate`, which must succeed for the exact branch SHA before shipping.

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
| code review | … |
| build | … |
Verdict: READY / NOT READY — <blockers>
```
