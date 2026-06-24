---
description: Analyze .claude/metrics/skill-usage.log and recommend SKILL.md description tweaks for over/under-triggering skills — the analysis half of the skill self-improvement loop.
argument-hint: '[--apply] (default: report only, no edits)'
allowed-tools: Bash, Read, Glob
---

You are running Restura's skill self-improvement loop. A `PreToolUse(Skill)` hook
logs every skill invocation to `.claude/metrics/skill-usage.log` (machine-local,
git-ignored). Your job: turn that signal into concrete `description:` frontmatter
edits, per "Lessons from building Claude Code: how we use skills." The
measurement half exists; you are the tuning half.

Scope: `$ARGUMENTS`. Default is report-only. `--apply` lets you offer to write the
edits after presenting the report.

## Steps

1. Run `node scripts/skill-usage-report.mjs --json` and parse the result.
   - If `status` is `no-data`: report that no skills have fired on this machine
     yet, list the defined skills from `neverFired`, and stop. There is nothing
     to tune — the log accumulates per-clone, so this is expected on a fresh
     checkout.
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
     plugin/global skills (e.g. `deep-research`, `code-review`) that live outside
     this repo. Distinguish the two before acting: a plugin skill firing is
     healthy and needs no edit; a stale local name suggests a rename the log
     predates. Never recommend a description edit for a plugin skill.
4. Keep recommendations specific to THIS repo's two skills and any plugin skills
   that surfaced. Do not invent skills.

## Output

ONE consolidated report. Per skill:

- current trigger summary (one line),
- the signal: `<total> invocations / <sessions> sessions / <inv-per-session>`,
- a verdict: ✅ healthy / ⬆️ broaden / ⬇️ tighten / 👻 ghost (plugin or stale),
- and the exact before→after `description:` rewrite when a change is warranted.

End with a prioritized list of recommended edits (highest-signal first), or
"No description changes recommended" if every skill looks healthy.

If `--apply` was passed, after presenting the report, offer to apply the
description edits to each SKILL.md — **frontmatter `description:` only, never the
skill body**. Apply only the edits the user confirms. Without `--apply`, report
only; do not edit any file.
