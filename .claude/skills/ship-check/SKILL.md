---
name: ship-check
description: "Run Restura's full ship-readiness gate (what `npm run validate` covers plus what it misses: reviewers, docs parity, combined-diff integration for multiple branches) and triage failures to file:line. Use before opening/merging a PR, 'is this ready to ship', or 'review my branch(es)'."
argument-hint: '[--quick | --full] (default: scope to the current diff)'
allowed-tools: Bash, Read, Grep, Glob, Agent, Task, Skill
---

You are running the Restura ship-readiness gate. First invoke the `restura-production-checks` skill so its gotchas are loaded. Then execute the gates below, collect results, and produce ONE consolidated checklist. Do not stop at the first failure — run everything, then report.

Scope: `$ARGUMENTS`. If `--quick`, skip builds, e2e, and bundle size. If `--full`, include them. Default: run the core gate + builds, skip e2e unless the diff touches protocol/transport code.

**Multiple branches/PRs**: if `$ARGUMENTS` names more than one branch or PR, run `npm run integration-check -- <branches> --keep` FIRST (add `--e2e` if protocol/transport/UI is touched). Report merge conflicts and the file-overlap matrix up front; any overlap on a non-registry file is a planning defect (those PRs should be one PR). Then review the **combined** result, because seam bugs are invisible per branch: the security auditor runs per branch (only where a branch touches a boundary), while `/code-review`, the parity checker and the docs steward run ONCE on the combined diff (`git diff <base>..HEAD` in the kept worktree) with the overlap matrix as context. Remove the kept worktree afterwards. `/ship-check` only reviews; it never merges or opens PRs, so it works before any PR exists. Merging is a separate, later step through the merge lane (`gh pr merge <n> --auto --squash`), which updates each PR onto current `main` one at a time and re-runs CI on the combined result.

Determine the diff under review: `git diff --stat main...HEAD` and `git status --porcelain`.

## Gates (run all; capture pass/fail + output)

1. **Type-check (all six projects)** — `npm run type-check:all`. NOTE: plain `type-check` only covers the renderer; this is the real gate. If it fails but renderer is clean, the error is in worker/electron-main/cli/echo/http.
2. **Lint** — `npm run lint`.
3. **Codegen freshness** — `npm run verify:opencollection-types` and `npm run capabilities:check`. On failure, the fix is to regenerate (`gen:opencollection-types` / `capabilities:matrix`), not hand-edit.
4. **Unit/integration + coverage** — `npm run test:run`.
5. **Agent review fan-out** — dispatch every applicable reviewer **in parallel** (one message, multiple Task calls — they are independent; serializing them wastes the wall-clock of every faster agent):
   - `restura-security-auditor` — if the diff touches `shared/protocol/`, `electron/main/security/` (DNS/broker guards, secret-handle store), `electron/main/storage/userdata-guard.ts`, `electron/main/ipc/` (validators, rate limiter), `worker/shared/dns-guard-node.ts`, secret stores, sandboxes, or adds a `*-handler.ts`. Also confirm the relevant `tests/security/*` passed in step 4.
   - `restura-parity-checker` — if the diff adds/changes a protocol, auth, or networked feature (it also reviews `cli/` executors). With several branches, pass it every branch's diff so duplicate transforms across branches are visible.
   - `restura-docs-steward` — always (CI has no content-parity gate). Run `npm run docs:check` alongside it.
   - **Fresh-context code review** — for any non-trivial diff, also invoke the repo's `code-review` skill (`.claude/skills/code-review`, three parallel axes: Correctness, Standards, Spec) against the same base. A reviewer that did not write the code is not influenced by the authoring session's reasoning; the agents above check domain properties, its Correctness axis checks bugs, edge cases, error paths and cross-harness seams. Treat its **blocking** Correctness findings as ship blockers.
6. **Builds** (unless `--quick`) — `npm run build` and `npm run electron:compile`. Start these as **background Bash** in the same message as the agent dispatch so they overlap the fan-out — running them afterwards serializes the two slowest gates.
7. **Bundle size** (only `--full`) — `npm run size`.
8. **e2e** (only `--full`, or if protocol/transport changed) — `npm run test:e2e`.

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

## PR marker

When the verdict is **READY**, print this line for the PR body (one per branch, using the branch's current HEAD sha):

```
<!-- restura:ship-check verdict=READY sha=<full HEAD sha> -->
```

`claude-code-review.yml` skips its automatic review when the PR body carries a READY marker for the PR's exact head sha — the local fan-out already covered it. The CI review only triggers on open/ready/reopen, so the sha must be the HEAD you push before opening the PR; if you push more commits first, re-run `/ship-check` and update the marker. The `claude-review` label always forces a run. Never write the marker for a NOT READY verdict or a sha you did not check.
