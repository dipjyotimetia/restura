# Harness eval: does the review pipeline catch seam bugs?

Restura's worst bugs this year were **seam bugs**: PRs that were green alone but broken together,
or a change wired into one harness (web Worker / Electron / CLI) or one consumer and not the
other. This suite measures whether the review entry point (`/ship-check --quick <branches>`,
with its parity / security / docs agents and the integration check) catches them, and whether
it raises false alarms on PRs that were fine. Run it as a baseline before changing the reviewer
setup, for example before folding the parity or docs subagents into main-loop skills.

The design follows Anthropic's guidance on agent evals: a small set of golden cases, graded on
the final outcome with a rubric judge that is not the model under test, several trials per case
reported as pass@1 / pass@n / pass^n with confidence intervals, a held-out split, transcripts you can read,
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
case's `notes` field says what was elided. Controls are whole merged PRs, or their source hunks
with tests dropped to stay under about 300 lines (the case's `notes` say so); `git log` shows no
later commit touching their files.

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
would change nothing. When the overlay was introduced (2026-10-25), `git cat-file -e <base>:<path>`
on every case then in the suite showed:

- no base had `.claude/skills/ship-check/` (the `/ship-check` skill); all but one only had the
  older `.claude/commands/ship-check.md`, and `sigv4-interactive-send-dropped` (2b6b3b58) has no
  ship-check at all, nor `.claude/agents`, `.claude/hooks`, `.claude/settings.json` or
  `docs/agents`;
- no base had `scripts/verify-agent-report.mjs`; only the two synthetic SSE cases (68ff7139) had
  `scripts/integration-check.mjs` and `scripts/worktree-setup.mjs`, so on the rest the prompt's
  `npm run integration-check` did not exist.

So, after the run's repo is created at `base` and before any branch is cut, the runner applies
an **overlay** (`overlayHarness`):

1. removes the base's `.claude/skills`, `.claude/agents`, `.claude/commands`, `.claude/hooks`,
   `.claude/settings.json` and `.agents/skills` (whatever exists);
2. extracts (`git archive`) from the harness commit (`--harness-ref`, resolved once per
   invocation)
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

## Isolation (why the review never runs in a worktree of this repo)

A `git worktree` of this repo shares its whole object store and refs, so a reviewer could
`git log --all` or `git show` its way to the later fix commit (for example the
`fix(mcp): keep launch settings/headers toggle usable…` that resolves `mcp-panel-collapse`) and
read the answer. Anthropic's eval guidance is to keep answers structurally out of the model's
reach, not to ask it not to look. So each run builds a **history-free repo** in its own temp dir
(`createIsolatedRepo`):

1. `git init`, then the case base's *tree* via `git -C <repo> archive <base> | tar -x` (argv
   arrays, no shell), committed as `base`;
2. the harness overlay above, also from `git archive`, committed as `harness overlay @ <sha12>`
   (the effective base);
3. `main` and `refs/remotes/origin/main` point at the effective base, so `origin/main` and
   `git diff main...<branch>` work; no remote is configured, so fetch and push fail closed.

`git log --all` there shows exactly those two commits plus the case branches. This repo is only
read (`archive`, `cat-file`, `show`, `rev-parse`): no branches, worktrees or refs are created
in it, and cleanup is deleting the temp dir. `node_modules` are symlinked from the main checkout
(like `npm run worktree:setup`, which only accepts linked worktrees). Those symlinks and absolute
paths still lead to the main checkout, so `detectContamination` scans the review transcript and
fails closed on: a tool input naming the main checkout (or its realpath); git `-C` /
`--git-dir` / `--work-tree` / `GIT_DIR=` targets outside the isolated repo; symlink-resolution
tricks in inputs (`readlink`, `realpath`, `pwd -P`, `cd -P`, `node_modules/..`); and a tool
result revealing the main checkout (except paths running through `node_modules`, which stack
traces through the symlinks produce on their own). A hit makes the run a harness error
(`contaminated: …`, hits listed in the summary), excluded from scoring.

### Secrets and the limits of this sandbox

The reviewer's Bash inherits the environment, and the stream records tool results, so `env` or
`/proc/self/environ` output would end up in artifacts. `redactSecrets` replaces the values of
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN` and any variable
whose name contains TOKEN, SECRET, PASSWORD, API_KEY or PRIVATE_KEY (values of 12+ characters)
with `[REDACTED:<NAME>]` before any transcript, result `.json` / `.md` or baseline is written.

The review denies `git push`, `gh`, `curl`, `wget`, WebFetch and WebSearch (so it cannot fetch
the fix from GitHub), but **`--disallowedTools` patterns are not a sandbox**: Bash can reach the
network or the filesystem in other ways. A local run gives the reviewer the developer's Bash, with
their `gh` config, SSH keys and home directory. Prefer CI or a container for untrusted cases.

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
- **Judge consistency.** `--judge-repeat N` (1 or 3: odd, so the vote never ties) grades the
  same review N times. All verdicts are kept (`judge.verdicts`); the judge's `caught` is the
  strict majority and its score the mean. A run where the verdicts differ counts as a **judge disagreement**,
  per case and in total: that is grader noise, separate from reviewer flips.
- **Harness errors are not misses.** A run gets `status: "error"` with a reason, and is left out
  of recall and precision, when `claude` exits non-zero or is killed, its output cannot be parsed
  (or the review stream has no `result` event), the review's answer is empty, the review was
  contaminated (see Isolation), the result reports `permission_denials`, an
  `error_*` subtype (budget, max turns) or `is_error`, stderr reports a tool that is not allowed,
  a permission denial or budget exhaustion, the overlay or a patch fails to apply, or the judge
  fails. Errors are listed in the summary.

## Metrics

The markdown summary reports:

- **Recall on defect cases** and **control precision** (clean / false positives), each with a
  Wilson 95% confidence interval, plus the error and judge-disagreement counts.
- Per case: caught / scored runs; **pass@1** (= c/n, the per-trial rate); **pass@n** (at least
  one of the n scored runs caught it) and **pass^n** (all n did), using the unbiased estimators
  pass@k = 1 − C(n−c,k)/C(n,k) and pass^k = C(c,k)/C(n,k) with k = n. The column headers carry the
  actual n (`pass@2`, `pass^2`); when cases have different scored-run counts the header says `n`
  and each cell shows `(n=…)`. Also: mean judge score; judge-only and pattern-only counts; judge
  disagreements; mean cost (review + judge, USD) and mean minutes per run; links to each run's
  transcript.
- **pass@1 totals**: the mean per-case pass@1 for defects and for controls. pass@n and pass^n
  depend on n, so compare **pass@1** across invocations with different `--runs`.
- **Totals**: cost and minutes for the whole invocation.
- **Noise**: how many cases flipped within this invocation, and the recall CI half-width.
  **Don't act on a config difference smaller than the CI half-width; add runs or cases.** With
  about 20 scored defect runs, the half-width is around 20 points.
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

Every case has a required `split` (the Cases table shows it). The rule: about 30% of cases are
held out as **test** (a unit test keeps it between 20% and 40%), the test split always has at
least one control and at least one defect, and a case's split is assigned once, when it is
added, and never moved after results have been seen. Everything else is **train**.
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
`evals/harness/baselines/<YYYY-MM-DD>T<HHMM>--<config>.json` (UTC start time, so same-day runs
never collide; the runner refuses to overwrite an existing file and checks before the run
starts): config, `harnessSha`, start time, runs per case, models, split, and per case caught /
runs / pass@1 / pass@n / pass^n / mean score / mean cost, plus recall and precision with CIs, the
pass@1 totals and the routing counts. It contains no review text, judge reasons
or transcripts, so it is safe to commit, and it is how an A/B result outlives the gitignored
`.claude/metrics/`. `--compare` and the automatic flip report accept a full result or a baseline
file. See `baselines/README.md`.

## Running

```bash
npm run eval:harness -- --dry-run                 # validate cases, apply overlay + patches, check the combined merge; no model calls
npm run eval:harness -- --case mcp-panel-collapse # one case, 2 runs, config "current", harness = HEAD
npm run eval:harness -- --split train --runs 3    # hillclimb on train only
npm run eval:harness -- --cleanup                 # remove legacy harness-eval/* branches and worktrees
```

A/B comparison of two harness versions (same cases, same models, different harness commit):

```bash
npm run eval:harness -- --harness-ref main --config A --runs 3 --save-baseline
npm run eval:harness -- --harness-ref <branch> --config C --runs 3 \
  --compare evals/harness/baselines/<YYYY-MM-DD>T<HHMM>--A.json
```

Options:

- `--case <id>` (repeatable); `--split train|test|all` (default `all`).
- `--runs N` (1-20, default 2).
- `--config <label>` (default `current`; `[A-Za-z0-9._-]+` without `--`): recorded, names the
  output files and selects the previous result with exactly that config for the flip report.
- `--harness-ref <ref>` (default `HEAD` of the checkout running the script): the harness commit
  overlaid on every case base, resolved once per invocation.
- `--model <model>` (reviewer; default: the `claude` CLI default), `--judge-model <model>`
  (default `sonnet`), `--judge-repeat 1|3` (default 1), `--no-judge`.
- `--max-budget-usd <n>` (per review run, default 20).
- `--out <dir>` (default `.claude/metrics/evals/`, gitignored).
- `--compare <result-or-baseline.json>` (flip report against a specific earlier result or a
  committed baseline, for example another config), `--save-baseline`.
- `--dry-run`, `--cleanup`.

For each run the runner:

1. builds the history-free repo at `base` in a temp dir, applies the harness overlay and commits
   it (the effective base), creates each case branch (plain name, e.g. `feat/mcp-import`) from
   the patches on top of it, then checks that all branches merge together without a textual
   conflict (the defect must be semantic);
2. links `node_modules` from the main checkout and runs
   `claude -p --output-format stream-json --verbose` with `/ship-check --quick <branches>` plus a
   note to treat the effective base as `main`, saving the stream as the run's transcript. The
   prompt is the same for defect cases and controls and never hints at the outcome. Tools are
   limited to Bash, Read, Grep, Glob, Task and Skill, with `git push`, `gh`, `curl`, `wget`,
   WebFetch and WebSearch denied, and `--max-budget-usd` caps each review (a timed-out child gets
   SIGTERM, then SIGKILL after 10 s); secrets are redacted from the stream before it is saved;
3. grades the final text (see Grading), calling the judge `--judge-repeat` times;
4. always removes the run's temp dir (the isolated repo lives inside it). SIGINT/SIGTERM stop the
   children (every live process, both ends of a pipe included), remove it and exit non-zero
   (130 / 143). `--cleanup` removes leftovers of older
   versions of this runner, which used worktrees of this repo: only branches under
   `harness-eval/` and worktrees under this tool's `restura-harness-eval-*` temp dirs.

Each invocation writes `<timestamp>--<config>.json` and `.md`, and the transcripts directory next
to them. When an earlier result for the same config exists (or `--compare` is given), the summary
includes a **flip report**: cases, defect or control, whose caught rate over scored runs changed.
The per-case table also flags cases whose runs disagreed within one invocation.

A full run is (number of cases) x `--runs` reviews with `/ship-check --quick`, plus as many judge
calls times `--judge-repeat`. That is slow and costs real money (the summary's totals line tells you how much), so run it
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
5. Give it a `split` before running it, keeping the test share near 30% with at least one control
   and one defect held out (see "Train / test split"). Never move a case between splits after
   its results have been seen.
