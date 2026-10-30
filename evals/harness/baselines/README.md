# Harness eval baselines

Committed, summary-only results of `npm run eval:harness`, written by `--save-baseline` as
`<YYYY-MM-DD>T<HHMM>--<config>.json` (UTC start time; an existing file is never overwritten).
They let an A/B comparison outlive the gitignored `.claude/metrics/evals/` directory:
`--compare evals/harness/baselines/<file>.json` diffs a new run against one.

## What goes here

One JSON per deliberate baseline run: config label, `harnessSha`, `claudeVersion` (the Claude
Code CLI that reviewed; compare baselines only across the same version), start time, runs per case,
reviewer and judge models, split, and per case caught / runs / pass@1 / pass@n / pass^n / mean judge
score / mean cost and minutes, plus recall and control precision with Wilson 95% CIs, totals and
the skill/agent routing counts.

## What never goes here

Review text, judge reasons and transcripts. Those stay in `.claude/metrics/evals/` (gitignored):
they can quote code and findings verbatim, and committing them invites pasting case specifics
into the harness (see the hillclimbing rules in `../README.md`). `buildBaseline` in
`scripts/harness-eval.mjs` strips them; do not hand-edit a baseline to add them back.

A baseline is a measurement, not a target. Before acting on a difference between two baselines,
check it is larger than the recall CI half-width.

## How a baseline gets here

Locally: `npm run eval:harness -- --split test --runs 2 --save-baseline`. In CI: dispatch the
`Eval harness` workflow with `save-baseline` ticked and commit the `eval-baseline-<run id>`
artifact. Until a baseline is committed, ADR 0033's "at or above the baseline" rule has nothing
to compare against; the first baseline is therefore a prerequisite for any reviewer or routing
change, not an optional extra.
