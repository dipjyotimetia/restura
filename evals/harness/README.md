# Harness eval: does the review pipeline catch seam bugs?

Restura's worst bugs this year were **seam bugs**: PRs that were green alone but broken together,
or a change wired into one harness (web Worker / Electron / CLI) or one consumer and not the
other. This suite measures whether the review entry point (`/ship-check --quick <branches>`,
with its parity / security / docs agents and the integration check) catches them, and whether
it raises false alarms on PRs that were fine. Run it as a baseline before changing the reviewer
setup, for example before folding the parity or docs subagents into main-loop skills.

The design follows Anthropic's guidance on agent evals: a small set of golden cases, graded on
the final outcome with a rubric judge that is not the model under test, several trials per case
reported as pass@k / pass^k with confidence intervals, a held-out split, transcripts you can read,
and cost per run. Per-case flips are reported, not only the aggregate.

## Layout

```
evals/harness/
  cases/<id>.yaml          one case per file (schema below)
  fixtures/<id>/*.patch    the branch(es) as they were BEFORE the fix (minimised), or a clean PR
  rubric.md                LLM judge rubric (defect and control sections)
  baselines/               committed summary-only results (--save-baseline); never transcripts
scripts/harness-eval.mjs   runner
```

## Cases

| id | type | split | origin | seam | source → fix |
|---|---|---|---|---|---|
| mcp-panel-collapse | defect | train | real | cross-branch | #1133 + #1134 → #1150 |
| mcp-runner-auth-override | defect | train | real | cross-consumer | #1131 → #1151 |
| cli-auth-double-expansion | defect | train | real | cross-consumer | #1163 (commits 1-2) → #1163 (commit 3) |
| sigv4-interactive-send-dropped | defect | train | real | cross-consumer | c6c751c2 → 115b64f1 / 0ef20dc7 |
| cli-grpc-auth-block-parity | defect | train | real | cross-harness | #1088 → #1161 |
| cli-graphql-get-parity | defect | **test** | real | cross-harness | #1109 → #1161 |
| kafka-preset-registry-bearer | defect | **test** | real | cross-branch | #1127 after #1130 → #1153 |
| grpc-no-deadline-web-stream | defect | train | real | cross-harness | #1089 → #1152 |
| sse-post-body-web-unwired | defect | train | synthetic | cross-harness | none |
| sse-spec-signature-seam | defect | **test** | synthetic | cross-branch | none |
| clean-cli-esm-require | control | train | real | none | #1155, no follow-up fix |
| clean-set-cookie-cap | control | **test** | real | none | #1158, no follow-up fix |

Real defect cases are reconstructed from `docs/audits/post-merge-review-2026-10-25.md` and git
history. Each `base` is the main commit the original branch was cut from (or merged onto), and
the patches are that branch's source hunks with tests, docs and unrelated files removed. Each
case's `notes` field says what was elided. Controls are whole merged PRs, unmodified; `git log`
shows no later commit touching their files.

### Case schema

```yaml
id: kebab-case, equal to the file name
title: one line
origin: real | synthetic
split: train | test       # required; see "Train / test split"
expectClean: false        # true for a control
sourcePRs: ['#1133']      # required for real cases
fixPRs: ['#1150']         # optional
base: <40-char SHA>       # the branches are cut from here
sourceCommit: <40-char SHA>  # optional: the patch is exactly the diff base..sourceCommit
seam: cross-branch | cross-harness | cross-consumer   # `none` for a control
branches:                 # 1-3; each patch is applied and committed in order
  - name: feat/x
    patches: [01-a.patch]
expected:
  defect: what breaks and why (defect cases; fed to the judge only, never to the reviewer)
  summary: what the change does (controls only)
  files: [paths a correct review must cite / the control's files]
  symbols: [optional]
mustMention: [case-insensitive regexes; defect cases only, must be empty for controls]
mustNotMiss: critical | high | medium | low   # defect cases only
notes: minimisation notes
```

At least one `mustMention` pattern in a defect case must name a file (path, basename or stem)
or symbol from `expected.files` / `expected.symbols`; that is the case's **anchor**. The
validator rejects an anchor that also matches generic review prose (for example
`(\bGET\b|web)`), because it would credit a review that never located the bug. Keyword
patterns use word boundaries (`\bdouble[- ]?expan`, not `double`, which matches
`double-check`), and a unit test runs every case pattern against bare-word distractors.
Patterns are case-insensitive; use `(?-i:\bGET\b)` where case matters.

## The harness overlay (why the eval tests the right harness)

Each case's `base` is the old main commit its branch was cut from. Checking that commit out also
checks out *its* `.claude/skills`, `.claude/agents`, hooks, `CLAUDE.md` and review scripts, so
without help a run would review with whatever harness existed months ago, and a `--config` A/B
would change nothing. `git cat-file -e <base>:<path>` on the 12 cases (2026-10-25) shows:

- no base has `.claude/skills/ship-check/` (the `/ship-check` skill); 11 of 12 only have the
  older `.claude/commands/ship-check.md`, and `sigv4-interactive-send-dropped` (2b6b3b58) has no
  ship-check at all, nor `.claude/agents`, `.claude/hooks`, `.claude/settings.json` or
  `docs/agents`;
- no base has `scripts/verify-agent-report.mjs`; only the two synthetic SSE cases (68ff7139) have
  `scripts/integration-check.mjs` and `scripts/worktree-setup.mjs`, so on the other 10 the
  prompt's `npm run integration-check` did not exist.

So, after the worktree is created at `base` and before any branch is cut, the runner applies an
**overlay** (`overlayHarness`):

1. removes the base's `.claude/skills`, `.claude/agents`, `.claude/commands`, `.claude/hooks`,
   `.claude/settings.json` and `.agents/skills` (whatever exists);
2. checks out from the harness commit (`--harness-ref`, resolved once per invocation)
   `.claude/skills .claude/agents .claude/hooks .claude/settings.json .agents CLAUDE.md AGENTS.md
   docs/agents skills-lock.json scripts/integration-check.mjs scripts/verify-agent-report.mjs
   scripts/worktree-setup.mjs scripts/worktree-prune.mjs`, each only if it exists there (never
   `.claude/worktrees`, `.claude/metrics` or `settings.local.json`);
3. merges only the `integration-check`, `verify:agent-report`, `worktree:setup` and
   `worktree:prune` scripts into the base's `package.json` (the rest of it is untouched);
4. commits that as `harness overlay @ <sha12>`. The commit is the **effective base**: branches
   are cut from it, the combined merge starts from it, and the review prompt names it as
   `main`/`origin/main`, so the overlay never shows up in a reviewed diff. Product code, product
   gates (`npm run validate` and friends) and everything else stay at the case base.

Each run records `harnessSha` and `effectiveBase`. The overlay uses the harness's *committed*
state: uncommitted edits in your checkout are not tested, so commit (or point `--harness-ref` at a
branch) first. `--dry-run` applies the overlay too, so a green dry run proves every case's
patches still apply on top of the harness under test.

## Grading

- **Defect case**: `caught` only when the rubric judge says caught **and** an anchor pattern
  matches. The run records the judge's verdict (`judgeCaught`) and the anchor match
  (`patternCaught`) separately, and the summary counts judge-only and pattern-only runs so
  disagreements between the two graders show up. With `--no-judge`, every `mustMention`
  pattern must match.
- **Control** (`expectClean: true`): `caught` means the review reported no high or medium
  defect in the fixture's files, according to the judge's control rubric. Controls need the
  judge.
- **The judge is not the model under test.** It defaults to `--judge-model sonnet`; set the
  reviewer with `--model`. When both are the same model the runner prints a warning.
- **Judge consistency.** `--judge-repeat N` (1-3) grades the same review N times. All verdicts
  are kept (`judge.verdicts`); the judge's `caught` is the strict majority (a tie is not caught)
  and its score the mean. A run where the verdicts differ counts as a **judge disagreement**,
  per case and in total: that is grader noise, separate from reviewer flips.
- **Harness errors are not misses.** A run gets `status: "error"` with a reason, and is left out
  of recall and precision, when `claude` exits non-zero or is killed, its output cannot be parsed
  (or the review stream has no `result` event), the result reports `permission_denials`, an
  `error_*` subtype (budget, max turns) or `is_error`, stderr reports a tool that is not allowed,
  a permission denial or budget exhaustion, the overlay or a patch fails to apply, or the judge
  fails. Errors are listed in the summary.

## Metrics

The markdown summary reports:

- **Recall on defect cases** and **control precision** (clean / false positives), each with a
  Wilson 95% confidence interval, plus the error and judge-disagreement counts.
- Per case: caught / scored runs, **pass@k** (at least one of k runs caught it) and **pass^k**
  (all k did) with k = the case's scored runs, using the unbiased estimators
  pass@k = 1 − C(n−c,k)/C(n,k) and pass^k = C(c,k)/C(n,k); mean judge score; judge-only and
  pattern-only counts; judge disagreements; mean cost (review + judge, USD) and mean minutes per
  run; links to each run's transcript.
- **Totals**: cost and minutes for the whole invocation.
- **Noise**: how many cases flipped within this invocation, and the recall CI half-width.
  **Don't act on a config difference smaller than the CI half-width; add runs or cases.** With
  10 defect cases x 2 runs, the half-width is around 20 points.
- **Routing**: across review runs, how often each skill (Skill tool) and subagent (Task/Agent
  `subagent_type`) ran, by runs and calls. This is the signal for folding or pruning a reviewer:
  if `/ship-check` never routes to an agent, the agent is not what is catching the bugs.

### Transcripts

The review runs with `--output-format stream-json --verbose`; the raw stream of every run is
written to `<out>/<timestamp>--<config>/transcripts/<case>-run<k>.jsonl` and linked from the
per-case table (the judge stays `--output-format json`). Read them. A miss is only actionable once
you know whether the review never looked at the right file, looked and misjudged it, or hit a
harness problem; the aggregate cannot tell you which.

## Train / test split

Every case has a required `split`. The held-out **test** split is one control
(`clean-set-cookie-cap`) and three defects (`kafka-preset-registry-bearer`,
`cli-graphql-get-parity`, `sse-spec-signature-seam`); the other eight are **train**.
`--split train|test|all` (default `all`) filters the run.

Hillclimbing rules, when you change skills, agents or CLAUDE.md to raise these numbers:

1. Read only **train** transcripts. Do not open test transcripts while iterating.
2. Propose **one root-cause change per round** (one skill/agent/prompt change, not a batch).
3. Keep the change only if train improves **and** test improves. Train up with test flat means
   the change overfit the train cases: revert it.
4. Never paste failure content or case specifics (file names, symbols, the defect) into skills,
   agents or CLAUDE.md. Fix the behaviour, not the case.
5. Exclude a case as broken or ambiguous only after reading its transcripts, and say why in the
   case's `notes`.

## Baselines

`--save-baseline` additionally writes a **summary-only** JSON to
`evals/harness/baselines/<YYYY-MM-DD>--<config>.json`: config, `harnessSha`, start time, runs per
case, models, split, and per case caught / runs / pass@k / pass^k / mean score / mean cost, plus
recall and precision with CIs and the routing counts. It contains no review text, judge reasons
or transcripts, so it is safe to commit, and it is how an A/B result outlives the gitignored
`.claude/metrics/`. `--compare` and the automatic flip report accept a full result or a baseline
file. See `baselines/README.md`.

## Running

```bash
npm run eval:harness -- --dry-run                 # validate cases, apply overlay + patches, check the combined merge; no model calls
npm run eval:harness -- --case mcp-panel-collapse # one case, 2 runs, config "current", harness = HEAD
npm run eval:harness -- --split train --runs 3    # hillclimb on train only
npm run eval:harness -- --cleanup                 # remove harness-eval/* branches and worktrees left by a crashed run
```

A/B comparison of two harness versions (same cases, same models, different harness commit):

```bash
npm run eval:harness -- --harness-ref main --config A --runs 3 --save-baseline
npm run eval:harness -- --harness-ref <branch> --config C --runs 3 \
  --compare evals/harness/baselines/<date>--A.json
```

Options:

- `--case <id>` (repeatable); `--split train|test|all` (default `all`).
- `--runs N` (1-20, default 2).
- `--config <label>` (default `current`): recorded, names the output files and selects the
  previous result for the flip report.
- `--harness-ref <ref>` (default `HEAD` of the checkout running the script): the harness commit
  overlaid on every case base, resolved once per invocation.
- `--model <model>` (reviewer; default: the `claude` CLI default), `--judge-model <model>`
  (default `sonnet`), `--judge-repeat N` (1-3, default 1), `--no-judge`.
- `--max-budget-usd <n>` (per review run, default 20).
- `--out <dir>` (default `.claude/metrics/evals/`, gitignored).
- `--compare <result-or-baseline.json>` (flip report against a specific earlier result or a
  committed baseline, for example another config), `--save-baseline`.
- `--dry-run`, `--cleanup`.

For each run the runner:

1. adds a throwaway worktree at `base`, applies the harness overlay and commits it (the effective
   base), creates `harness-eval/<run-id>/<branch>` from the patches on top of it, then checks that
   all branches merge together without a textual conflict (the defect must be semantic);
2. links `node_modules` (`scripts/worktree-setup.mjs`) and runs
   `claude -p --output-format stream-json --verbose` with `/ship-check --quick <branches>` plus a
   note to treat the effective base as `main`, saving the stream as the run's transcript. The
   prompt is the same for defect cases and controls and never hints at the outcome. Tools are
   limited to Bash, Read, Grep, Glob, Task and Skill, with `git push` and `gh` denied, and
   `--max-budget-usd` caps each review;
3. grades the final text (see Grading), calling the judge `--judge-repeat` times;
4. always removes the worktree and the branches, one command at a time (worktree, then each
   branch, then prune). Anything that fails to go stays tracked, is retried after the next run
   and is reported (`cleanupFailed`, non-zero exit). SIGINT/SIGTERM stop the child, run the same
   cleanup and exit non-zero (130 / 143). `--cleanup` handles a hard crash: it removes only
   branches under `harness-eval/` and worktrees under this tool's `restura-harness-eval-*`
   temp dirs.

Each invocation writes `<timestamp>--<config>.json` and `.md`, and the transcripts directory next
to them. When an earlier result for the same config exists (or `--compare` is given), the summary
includes a **flip report**: cases, defect or control, whose caught rate over scored runs changed.
The per-case table also flags cases whose runs disagreed within one invocation.

A full run is 12 cases x 2 runs of `/ship-check --quick`, plus 24 x `--judge-repeat` judge calls.
That is slow and costs real money (the summary's totals line tells you how much), so run it
deliberately.

## Adding a case

1. Find the incident: the fix PR, the PR(s) that introduced it, and the main commit before
   them. For a control, pick a small merged PR with no later fix to its files.
2. In a scratch worktree at that commit, apply the introducing diff restricted to source files
   (`git diff <base> <merge> -- <files> | git apply`), trim it to the relevant hunks, and save
   `git diff --cached` as `fixtures/<id>/NN-name.patch`. Keep each patch under about 300 lines;
   split a branch into several patches if needed.
3. Write `cases/<id>.yaml`, then run `npm run eval:harness -- --dry-run --case <id>`.
4. Mark anything invented as `origin: synthetic`.
5. Give it a `split`. New cases go to `train` unless you are deliberately growing the held-out
   set; never move a case between splits to make a number look better.
