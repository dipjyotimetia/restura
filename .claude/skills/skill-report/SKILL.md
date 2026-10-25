---
name: skill-report
description: "Analyze .claude/metrics (skill usage, subagent and stop outcomes) and recommend SKILL.md description tweaks or pruning for over/under-triggering skills. Use when asked which skills are unused, mis-triggering, or should be deleted."
argument-hint: '[--apply] (default: report only, no edits)'
allowed-tools: Bash, Read, Glob
---

You are running Restura's skill self-improvement loop. Three hooks write
machine-local, git-ignored metrics under `.claude/metrics/`:

- `skill-usage.log` — `PreToolUse(Skill)`: every skill invocation.
- `subagent.log` — `SubagentStop`: every finished subagent, by agent type.
- `stop-outcomes.log` — `Stop` (`stop-checks.mjs`): which end-of-turn checks
  fired and whether the turn was blocked or allowed.

Your job: turn that signal into concrete `description:` frontmatter edits (and,
where the delegation/stop numbers warrant it, a recommendation), per "Lessons
from building Claude Code: how we use skills." The measurement half exists; you
are the tuning half.

Scope: `$ARGUMENTS`. Default is report-only. `--apply` lets you offer to write the
edits after presenting the report.

## Steps

1. Run `node scripts/skill-usage-report.mjs --json` (`npm run skills:report`
   for the human tables) and parse the result. Top-level fields are the skill
   section; `subagents` and `stopOutcomes` are their own sections, each with a
   `status` of `ok` or `no-data` (a missing log is never an error).
   - If the top-level `status` is `no-data`: report that no skills have fired on
     this machine yet and list the defined skills from `neverFired` — the log
     accumulates per-clone, so this is expected on a fresh checkout. Still
     report the `subagents` / `stopOutcomes` sections (step 5) if they have
     data; otherwise stop.
2. For every skill in `skills` and every name in `neverFired`, read its
   `.claude/skills/<dir>/SKILL.md` and extract the current `description:` line
   (the frontmatter between the first two `---` fences). Use Glob/Read.
3. Judge each skill against its numbers. Treat `invocationsPerSession` as a
   **crude** signal, not proof — one heavy session skews it; say so when a call
   is low-confidence.
   - **Over-triggering** — high `invocationsPerSession` (roughly > 2) OR a high
     `total` relative to peers, especially when the `description` uses broad
     trigger phrases ("any work in src/...", "even small changes"). Recommend
     TIGHTENING: narrow the trigger phrases and add an explicit "do NOT use for
     trivial X" scope (see how `restura-feature-dev`'s "When NOT to use this
     skill" section already does this).
   - **Under-triggering** — appears in `neverFired`, or low `total` despite work
     you'd expect to match. Recommend BROADENING: add concrete trigger phrases /
     synonyms a user would actually type.
   - **Ghosts** (`ghosts[]`) — names in the log that match no skill in
     `.claude/skills/`. These are EITHER renamed/removed local skills OR
     plugin/global skills (e.g. `deep-research`, `engineering:code-review`) that live outside
     this repo. Distinguish the two before acting: a plugin skill firing is
     healthy and needs no edit; a stale local name suggests a rename the log
     predates. Never recommend a description edit for a plugin skill.
4. Cover every local skill the analysis reports (both the `skills` counts and
   `neverFired`), plus any plugin skills that surfaced. Do not invent skills.
5. Read the other two sections (skip any with `status: no-data`):
   - **`subagents`** — `byType[]` (`type`, `total`, `sessions`), `total`,
     `sessions`, `meanPerSession`, anonymised `perSession` counts. A
     `(unknown)` type means the SubagentStop payload carried no agent type.
     Flag a `.claude/agents/*` agent that never appears while the skills that
     dispatch it (`ship-check`, `batch-ship`, `docs-sync`) did fire — the
     dispatch may be silently skipped. Note very high per-session counts as a
     fan-out cost, not automatically a bug.
   - **`stopOutcomes`** — `total`, `blocked`, `allowed`, `blockRate`, and
     `checks[]` (`name`, `fired`, `fireRate`). A check with a high `fireRate`
     is either catching real drift or nagging; say which is likelier and
     whether its trigger in `.claude/hooks/stop-checks.mjs` should narrow.
     Recommend only — never edit hooks from this skill.

## Output

ONE consolidated report. Per skill:

- current trigger summary (one line),
- the signal: `<total> invocations / <sessions> sessions / <inv-per-session>`,
- a verdict: ✅ healthy / ⬆️ broaden / ⬇️ tighten / 👻 ghost (plugin or stale),
- and the exact before→after `description:` rewrite when a change is warranted.

Then a short **Subagents** table (type, runs, sessions; plus mean per session)
and a **Stop-hook outcomes** table (check, fired, fire rate; plus blocked vs
allowed), each with one line of interpretation, or "no data yet".

End with a prioritized list of recommended edits (highest-signal first), or
"No description changes recommended" if every skill looks healthy.

If `--apply` was passed, after presenting the report, offer to apply the
description edits to each SKILL.md — **frontmatter `description:` only, never the
skill body**. Apply only the edits the user confirms. Without `--apply`, report
only; do not edit any file.
