---
name: batch-ship
description: "Orchestrate delivering SEVERAL fixes/issues as parallel PRs with worktree agents: file-ownership plan, red-first verification, combined-diff review, integration-check, merge lane. Use when given 2+ issues/tasks to ship together, 'fix these issues in parallel', or 'ship this epic'. Single-PR work does not need it."
argument-hint: '[issue numbers or short task list]'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Task
---

You are the orchestrator for a batch delivery. Scope: `$ARGUMENTS`. Read the
"Shipping multi-PR work" section of `docs/agents/delivery.md` first; this skill is its recipe.

1. **Plan by file ownership.** For each task list the files it will touch
   (include `cli/src/runner/executors/*` for protocol/auth work and the
   per-area registry module). Two tasks sharing a non-registry file become
   one PR. Cap the batch at 5 PRs; prefer vertical slices (web + desktop +
   CLI). Fix or quarantine known flakes that would hit these PRs first.
2. **Spawn at most 5 worktree agents** (`isolation: worktree`, one per PR, in
   parallel). Each brief states the goal, the owned files, what is out of
   scope, and the checklist: `npm run worktree:setup`; explicit `git add
   <paths>`; `git show --stat` after each commit; tests run red against the
   unfixed code first; inline snapshots only; worker tests under `worker/`; no
   push/PR/`gh`; report branch, worktree path, SHA.
3. **Verify red-first yourself.** For at least one test per branch, check out
   the test without the fix and run it; confirm it fails for the stated
   reason. Reject agent claims that were not run.
4. **Review each branch**: `restura-security-auditor` (boundary changes),
   `restura-parity-checker` (including CLI), `restura-docs-steward`, plus a
   fresh-context `/code-review`. Fix findings on the owning branch.
5. **Integrate**: `npm run integration-check -- <all branches>` (`--e2e` if
   transport/UI changed). Any file overlap or duplicate transform between
   branches is a planning bug: merge those branches. Do not proceed red.
6. **Push one branch at a time** after `git fetch` and rebase on
   `origin/main`; open PRs (one topic each), noting the intended merge path.
7. **Auto-merge**: `gh pr merge <n> --auto --squash` for each; the merge lane
   (`merge-lane.yml`, from the delivery-guardrails PR; it must be on `main`
   first, since plain auto-merge neither orders PRs nor updates behind
   branches) serializes them, updating one behind-`main` PR at a time.
   Never `--admin` except emergencies. After each merge
   round re-run integration-check on the remainder (see `/babysit-prs`).
   Log any flake you hit instead of silently retrying.

End with a table: PR, owned files, red-first verified (Y/N), reviews, merge-lane
status, and any items left for a human.
