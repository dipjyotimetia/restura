---
name: skill-report
description: Analyze local Restura agent-skill usage data without exposing session identifiers and recommend trigger-description improvements.
---

# Report skill usage

Run `node scripts/skill-usage-report.mjs --json`. The current supported metric
source is Claude's ignored `.claude/metrics/skill-usage.log`; Codex has no
documented skill-invocation hook event, so do not pretend Codex usage is
measured. If data is absent, report that fact. For defined skills, assess
over-triggering and under-triggering conservatively, never print session ids,
and propose exact frontmatter `description` changes. Default to report-only;
apply edits only after explicit confirmation.
