# Harness eval baselines

Committed, summary-only results of `npm run eval:harness`, written by `--save-baseline` as
`<YYYY-MM-DD>T<HHMM>--<config>.json` (UTC start time; an existing file is never overwritten).
They let an A/B comparison outlive the gitignored `.claude/metrics/evals/` directory:
`--compare evals/harness/baselines/<file>.json` diffs a new run against one.

## What goes here

One JSON per deliberate baseline run: config label, `harnessSha`, `claudeVersion` (the Claude
Code CLI that reviewed; compare baselines only across the same version), start time, runs per case,
reviewer and judge models as requested and as resolved (`resolvedModels`: the ids the sessions
actually used; a comparison across different ids prints a warning), split, and per case caught /
runs / pass@1 / pass@n / pass^n / `alwaysFailed` / mean judge score / mean cost and minutes, plus
recall and control precision with Wilson 95% CIs, totals, the noise line and the skill/agent
routing counts. The flip report against a baseline also prints the mean cost and minutes per run
over the shared cases: cost is an objective, not a footnote.

## What never goes here

Review text, judge reasons and transcripts. Those stay in `.claude/metrics/evals/` (gitignored):
they can quote code and findings verbatim, and committing them invites pasting case specifics
into the harness (see the hillclimbing rules in `../README.md`). `buildBaseline` in
`scripts/harness-eval.mjs` strips them; do not hand-edit a baseline to add them back.

A baseline is a measurement, not a target. Before acting on a difference between two baselines,
check it is larger than the recall CI half-width.

## How a baseline gets here

Locally: `npm run eval:harness -- --split test --model claude-sonnet-5-5 --save-baseline` (3 runs,
the judge `claude-opus-5-5` x3 by default, never the model under test; `--model` is required because the CLI default varies per machine
and release, and the noise pre-flight refuses a plan whose worst-case recall CI half-width is
wider than `--max-noise`, 25 points). In CI: dispatch the `Eval harness` workflow with
`save-baseline` ticked (its `model` input is pinned to the same Sonnet the CI review jobs use and
its judge to Opus, so the judge is never the model under test) and commit the
`eval-baseline-<run id>` artifact.

Before the first baseline is trusted, do two things the runner cannot do for you and record both
in the baseline PR:

1. **Calibration.** Run the test split once with Sonnet and once with Opus as reviewer, with the
   same judge both times (the Opus run trips the self-judge warning; that is expected). A stronger
   reviewer must score at or above the weaker one on recall without worse precision; if it does
   not, the cases are ambiguous or the judge is wrong, and the baseline is not yet a measurement.
2. **Judge read-back.** Read every judge verdict in the result JSON (`judge.verdicts[].reason`,
   beside the review text) and count the ones you would have scored differently. The baseline
   file keeps only the disagreement counts; the reading is yours. Until a baseline is committed, ADR 0033's "at or above the baseline" rule has nothing
to compare against; the first baseline is therefore a prerequisite for any reviewer or routing
change, not an optional extra.
