---
name: batch-ship
description: "Orchestrate delivering SEVERAL fixes/issues as parallel PRs with worktree agents: file-ownership plan, red-first verification, combined-diff review, integration-check, merge lane. Use when given 2+ issues/tasks to ship together, 'fix these issues in parallel', or 'ship this epic'. Single-PR work does not need it."
argument-hint: '[issue numbers or short task list]'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Agent, Task, SendMessage, Skill
---

You are the orchestrator for a batch delivery. Scope: `$ARGUMENTS`. Read the
"Shipping multi-PR work" section of `docs/agents/delivery.md` first; this skill is its recipe.

Workers are tools with a fixed contract, not collaborators: you keep the plan
and the conversation, they return a structured report, and a script — not
your judgement — checks the report against git.

1. **Plan by file ownership.** For each task list the files it will touch
   (include `cli/src/runner/executors/*` for protocol/auth work and the
   per-area registry module). Two tasks sharing a non-registry file become
   one PR. Cap the batch at 5 PRs; prefer vertical slices (web + desktop +
   CLI). Fix or quarantine known flakes that would hit these PRs first.
   Write the plan down as `branch → owned paths` (exact paths, `dir/`
   prefixes or globs); step 3 checks against it verbatim.
2. **Spawn at most 5 worktree agents** (`isolation: worktree`, one per PR, all
   in ONE message so they run in parallel). Each brief is the agent's only
   context: the goal, the owned paths, what is out of scope, a turn budget
   (say so explicitly — e.g. "stop and report after ~40 tool calls"), and the
   checklist: `npm run worktree:setup`; explicit `git add <paths>`; `git show
   --stat` after each commit; tests written first and shown failing; inline
   snapshots only; worker tests under `worker/`; no push/PR/`gh` mutations
   (a hook denies pushes from `.claude/worktrees/`). The brief ends with the
   **report contract** — reply with ONLY:
   ```json
   {"branch": "", "worktree": "", "sha": "<full sha>", "filesTouched": [],
    "redFirst": {"command": "", "failingExcerpt": ""},
    "gates": {"tests": "pass", "lint": "pass", "typeCheckAll": "pass"},
    "outOfScopeNotes": [], "openQuestions": []}
   ```
   `filesTouched` is every file the branch changes vs `origin/main` (cumulative,
   also on follow-up rounds), and `sha` is the branch tip.
3. **Verify each report mechanically**:
   `node scripts/verify-agent-report.mjs <report.json> --owned <paths> --red-first`.
   It checks the sha is the branch tip, changed files ⊆ owned paths,
   `filesTouched` matches git, no gate failed, and that the red-first command
   FAILS on the base with only the branch's test files applied. On any
   `redFirst.command` is agent-written text that `--red-first` executes (in a
   throwaway worktree): read it first; it must be a plain test invocation. On any
   problem, send the script's output back to the SAME worker (`SendMessage`)
   to fix — don't redo its work yourself, and don't accept unrun claims.
   Answer its `openQuestions` in the same message (escalate real product
   decisions to the user).
4. **Integrate and review the combined result** — seam bugs are invisible
   per branch:
   - `npm run integration-check -- <all branches> --keep` (`--e2e` if
     transport/UI changed). Any file overlap or duplicate transform between
     branches is a planning bug: merge those branches. Do not proceed red.
   - Per branch: `restura-security-auditor` only where the branch touches a
     security boundary.
   - On the combined diff (`git diff <base>..HEAD` in the kept worktree,
     plus the ownership matrix): one fresh-context `/code-review` (Correctness, Standards, Spec) and the
     parity check (`restura-parity-checker`, CLI included), and
     `restura-docs-steward`. Dispatch them in one message.
   - Fix findings on the owning branch (via its worker), re-verify (step 3),
     re-run integration-check. Remove the kept worktree when done.
5. **Push one branch at a time** from the main checkout (`git push origin
   <branch>`) after `git fetch` and rebase on `origin/main`. Open PRs (one
   topic each) noting the intended merge path, and include the `/ship-check`
   marker line in the body (see the ship-check skill) so CI does not re-run a
   duplicate Claude review.
6. **Auto-merge**: `gh pr merge <n> --auto --squash`; the merge lane
   (`merge-lane.yml`) serializes them, updating one behind-`main` PR at a
   time. `--admin` is hook-gated (`RESTURA_ALLOW_ADMIN=1`) and for
   emergencies only. After each merge round re-run integration-check on the
   remainder (see `/babysit-prs`). Log any flake you hit instead of silently
   retrying.
7. **Clean up**: `npm run worktree:prune -- --apply --branches` removes the
   batch's worktrees once their PRs merged; it keeps anything dirty or
   unmerged and says why.

End with a table: PR, owned files, report verified (Y/N, incl. red-first),
reviews, merge-lane status, and any items left for a human.
