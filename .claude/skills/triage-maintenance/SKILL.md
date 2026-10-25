---
name: triage-maintenance
description: "Proactive maintenance loop body: dependabot PRs, security-audit findings, skill metrics, ratchet tightening, flake review, stale worktree pruning, eval upkeep (escaped defects to eval cases, saturation). Use for a scheduled/weekly sweep or 'do maintenance / triage the repo'."
argument-hint: '[--deps | --security | --skills | --ratchets | --worktrees | --eval-upkeep | --evals] (default: all six streams; --evals is opt-in)'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Task, Skill
---

You are one iteration of Restura's recurring maintenance loop. Six input
streams (plus an opt-in harness eval), each with a deterministic "done for this run" state. Scope:
`$ARGUMENTS` (default: all six; `--evals` is opt-in). Report one consolidated summary; skip
streams with nothing actionable.

## Stream 1 — Dependency PRs (`--deps`)

1. List open dependabot PRs (`gh pr list --author "app/dependabot"` locally,
   GitHub MCP remotely).
2. Green + patch/minor: leave for `dependabot-auto-merge`; do nothing.
3. Red CI: diagnose. If the branch is merely stale, comment `@dependabot
rebase` instead of pushing. If the repo needs a mechanical adaptation
   (renamed import, changed type), apply it on the dependabot branch and push
   — knowing that dependabot stops updating a branch once a foreign commit
   lands on it, so from that point the PR is yours to land. If the bump
   itself is breaking, comment with the diagnosis and label it for a human.
4. Major bumps: never merge; summarize the changelog delta and the migration
   surface in a PR comment.

## Stream 2 — Security findings (`--security`)

1. Check the latest `security-audit` and `scorecard` workflow runs and any
   open CodeQL/secret-scanning alerts.
2. For each new finding: classify — false positive (document why), mechanical
   fix (apply it via the normal branch + PR flow), or judgment call.
3. Anything touching `shared/protocol/`, the SSRF/DNS/broker guards, IPC
   validators, or secret stores is a judgment call by definition: dispatch
   the `restura-security-auditor` agent and include its verdict rather than
   deciding alone.

## Stream 3 — Skill metrics (`--skills`)

**Local-only stream.** `.claude/metrics/skill-usage.log` is written by the
PreToolUse hook on the machine where sessions run and is never committed — a
cloud-scheduled routine starts from a fresh clone and will always find it
missing. Skip silently in that case; run this stream on the machine where the
metrics accumulate.

1. Check growth against the watermark: compare the log's line count to the
   count recorded in `.git/restura-skill-report-watermark` (same
   marker-in-`.git` pattern as the repo's hooks; missing marker = never run).
   If unchanged, skip.
2. If grown: run `/skill-report`, apply its low-risk description tweaks
   directly, queue anything judgment-heavy for the user, then write the new
   line count to the watermark file.
3. This closes the instrumentation loop — logging usage without ever reading
   it is dead weight.

## Stream 4 — Ratchets and flakes (`--ratchets`)

1. Run `npm run architecture:tighten`. If it changes
   `scripts/architecture.config.mts`, open a small `chore:` PR with only that
   file (explicit `git add`), and enable auto-merge with `gh pr merge <n> --auto --squash`.
   Do it as its own PR, never inside a feature PR (the config is a hot file).
2. Flake review: scan recent CI runs (`gh run list --status failure`) and the
   merge-lane runs for tests that failed then passed on retry. Known offenders
   include grpc-web 413 and mcp-client-requests. For each, fix it or
   quarantine it with a tracked issue (if one exists, update it; documentation
   alone is not quarantine).
   Flakes must be fixed or quarantined before the next parallel batch.

## Stream 5 — Worktrees (`--worktrees`, local-only)

1. `npm run worktree:prune` (dry run) lists every linked worktree with a
   keep/prune verdict. Prune = clean (ignoring `worktree:setup`'s
   node_modules links) AND merged (nothing ahead, PR MERGED, or all commits
   patch-equivalent). Everything else is kept with its reason.
2. Apply with `npm run worktree:prune -- --apply --branches`. Never remove a
   kept worktree yourself: list dirty/unmerged ones for the human (they may
   hold private-advisory work that exists nowhere else).

## Stream 6 — Eval upkeep (`--eval-upkeep`)

1. **Escaped defects → eval cases, within the week.** Every merged fix PR
   labelled `escaped-defect` (or any fix PR for a bug that passed review)
   becomes an eval case: a harness review case scaffolded with
   `npm run eval:new-case -- --from <fixPR>`, or a build-loop task under
   `evals/build/`. List any escaped defect still without a case.
2. **Weekly read-back (local-only).** Run `npm run skills:report`; skills with
   0 uses over 4 weeks are **deletion candidates for the user** (never delete
   unasked). Read 3 sampled eval transcripts from
   `.claude/metrics/evals/*/transcripts/` — train split only — and note
   recurring failure modes.
3. **Saturation.** A case with pass^n = 1 across 3 committed baselines
   (`evals/harness/baselines/`) is regression-only. When the recall CI lower
   bound is ≥ 0.9, add harder cases instead of tuning the harness.
4. **No overfitting.** Never edit skills, agents or `CLAUDE.md` to fit a
   specific eval case. One root-cause change per hillclimb round; keep it only
   if train AND test both improve.

## Harness eval (`--evals`, opt-in, local-only, costs model usage)

Only when `.claude/`, `CLAUDE.md`, `AGENTS.md` or `docs/agents/` changed
since the last run (watermark: `.git/restura-harness-eval-watermark`, a
commit sha). Run `npm run eval:harness -- --config current` and report the
**flip report** (cases whose caught/missed changed), not just the score. A
newly missed seam case is a harness regression: queue it for the human.

## Discipline

- Route mechanical work cheaply; reserve deep reasoning for stream-2 judgment
  calls.
- Every code change goes through a branch + `/ship-check --quick` before
  push; this loop never commits straight to main.
- End with: streams checked, actions taken, items queued for a human. If all
  six streams were empty, say exactly that in one line.

## Scheduling

Run weekly (or on demand). To move it to the cloud:
`/schedule every monday 9am: run /triage-maintenance --deps --security`
(stream 3 is local-only — see above) — or keep it manual and run it at the
start of a maintenance session. Pilot it manually at least once before
scheduling, and set the routine to a cheaper model if stream 1 is the bulk of
the work.
