# Harness eval baselines

Committed, summary-only results of `npm run eval:harness`, written by `--save-baseline` as
`<YYYY-MM-DD>--<config>.json`. They let an A/B comparison outlive the gitignored
`.claude/metrics/evals/` directory: `--compare evals/harness/baselines/<file>.json` diffs a new
run against one.

## What goes here

One JSON per deliberate baseline run: config label, `harnessSha`, start time, runs per case,
reviewer and judge models, split, and per case caught / runs / pass@k / pass^k / mean judge
score / mean cost and minutes, plus recall and control precision with Wilson 95% CIs, totals and
the skill/agent routing counts.

## What never goes here

Review text, judge reasons and transcripts. Those stay in `.claude/metrics/evals/` (gitignored):
they can quote code and findings verbatim, and committing them invites pasting case specifics
into the harness (see the hillclimbing rules in `../README.md`). `buildBaseline` in
`scripts/harness-eval.mjs` strips them; do not hand-edit a baseline to add them back.

A baseline is a measurement, not a target. Before acting on a difference between two baselines,
check it is larger than the recall CI half-width.
