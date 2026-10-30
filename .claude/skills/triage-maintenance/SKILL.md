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
   Open Dependabot alerts belong to the `dependabot-remediate` workflow: check
   its latest run and any held `deps/dependabot-remediate` PR rather than fixing
   them here.
2. For each new finding: classify — false positive (document why), mechanical
   fix (apply it via the normal branch + PR flow), or judgment call.
3. Anything touching `shared/protocol/`, the SSRF/DNS/broker guards, IPC
   validators, or secret stores is a judgment call by definition: dispatch
   the `restura-security-auditor` agent and include its verdict rather than
   deciding alone.

## Stream 3 — Skill metrics (`--skills`)

**Local-first stream.** `.claude/metrics/skill-usage.log` is written by the
PreToolUse hook on the machine where sessions run and is never committed — a
cloud-scheduled routine starts from a fresh clone and will find it missing.
What IS committed are per-machine snapshots under `evals/metrics/`
(`npm run metrics:snapshot`, counts only, no session ids); `npm run
skills:report -- --merged` folds the latest snapshot of every other label
into the local report. On a machine with no local log, run the merged report
over the committed snapshots; skip only when there are no snapshots either.

1. Check growth against the watermark: compare the log's line count to the
   count recorded in `.git/restura-skill-report-watermark` (same
   marker-in-`.git` pattern as the repo's hooks; missing marker = never run).
   If unchanged, skip.
2. If grown: run `npm run metrics:snapshot` and include the new
   `evals/metrics/<date>--<host>.json` in this sweep's chore PR, then run
   `/skill-report` (it reads the merged view), apply its low-risk description
   tweaks directly, queue anything judgment-heavy for the user, and write the
   new line count to the watermark file.
3. This closes the instrumentation loop — logging usage without ever reading
   it is dead weight.

## Stream 4 — Ratchets and flakes (`--ratchets`)

1. Run `npm run architecture:tighten`. If it changes
   `scripts/architecture.config.mts`, open a small `chore:` PR with only that
   file (explicit `git add`), and enable auto-merge with `gh pr merge <n> --auto --squash`.
   Do it as its own PR, never inside a feature PR (the config is a hot file).
2. Flake review: scan recent CI runs (`gh run list --status failure`) and the
   merge-lane runs for tests that failed then passed on retry. For each, fix it or
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
3. **Saturation and always-failed.** A case with pass^n = 1 across 3 committed
   baselines (`evals/harness/baselines/`) is regression-only. When the recall
   CI lower bound is ≥ 0.9, add harder cases instead of tuning the harness. The
   mirror: a case with `alwaysFailed` across 2 baselines is suspect before it
   is a harness gap: read its transcripts for ambiguity or an unfair grader
   (fixture does not type-check on its own, severity the rubric cannot credit)
   and fix or drop the case, saying why in its `notes`.
4. **Breadth of cases.** When adding a case, prefer a seam, protocol or
   harness pair the suite does not cover (today every defect comes from PRs
   #1088 to #1165 and a third are MCP) over another variant of one it does.
5. **No overfitting.** Never edit skills, agents or `CLAUDE.md` to fit a
   specific eval case. One root-cause change per hillclimb round, large enough
   to clear the pre-flight half-width; keep it only if train improves and test
   does not regress. **When the score stalls** for two rounds, stop editing
   and bucket every remaining train failure by cause (ambiguous case, harness
   error, run-to-run variance, legitimate miss); only legitimate misses
   continue into further rounds. The summary's incomplete, contaminated,
   error, judge-disagreement and always-failed lists are the starting point.
6. **Cost is an objective.** Read the cost and minutes line in the flip report
   with the flips: "hold recall and precision, cut cost" is the goal of every
   reviewer fold, and it still applies when recall is saturated.

## Harness eval (`--evals`, opt-in, local-only, costs model usage)

Only when `.claude/`, `CLAUDE.md`, `AGENTS.md` or `docs/agents/` changed
since the last run (watermark: `.git/restura-harness-eval-watermark`, a
commit sha). Run `npm run eval:harness -- --split all --model <the baseline's
model> --save-baseline --compare evals/harness/baselines/<latest>.json`
(3 runs and judge x3 by default; the regression gate reads all cases, train
included) and report the **flip report** (cases whose caught/missed changed)
and its cost line, not just the score; commit the new baseline in the sweep's
chore PR. If no baseline is committed yet, say so first: ADR 0033 cannot gate
anything until one exists (the `Eval harness` workflow with `save-baseline`
produces one without local model usage), and the first baseline also needs
the calibration run and the judge read-back from `evals/harness/baselines/README.md`.
A newly missed seam case is a harness regression: queue it for the human. A
flip report that warns the compared run used a different Claude Code version
or different resolved models is noise until re-run like for like.

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
