---
description: 'Proactive maintenance loop body: triage dependabot PRs, security-audit findings, and skill-usage metrics in one pass. Designed for a scheduled routine (e.g. /schedule weekly) or an on-demand run.'
argument-hint: '[--deps | --security | --skills] (default: all three streams)'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Task
---

You are one iteration of Restura's recurring maintenance loop. Three input
streams, each with a deterministic "done for this run" state. Scope:
`$ARGUMENTS` (default: all three). Report one consolidated summary; skip
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

## Discipline

- Route mechanical work cheaply; reserve deep reasoning for stream-2 judgment
  calls.
- Every code change goes through a branch + `/ship-check --quick` before
  push; this loop never commits straight to main.
- End with: streams checked, actions taken, items queued for a human. If all
  three streams were empty, say exactly that in one line.

## Scheduling

Run weekly (or on demand). To move it to the cloud:
`/schedule every monday 9am: run /triage-maintenance --deps --security`
(stream 3 is local-only — see above) — or keep it manual and run it at the
start of a maintenance session. Pilot it manually at least once before
scheduling, and set the routine to a cheaper model if stream 1 is the bulk of
the work.
