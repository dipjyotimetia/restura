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
| mcp-panel-collapse | defect | train (seen) | real | cross-branch | #1133 + #1134 → #1150 |
| mcp-runner-auth-override | defect | train (seen) | real | cross-consumer | #1131 → #1151 |
| cli-auth-double-expansion | defect | train (seen) | real | cross-consumer | #1163 (commits 1-2) → #1163 (commit 3) |
| sigv4-interactive-send-dropped | defect | **test** | real | cross-consumer | c6c751c2 → 115b64f1 / 0ef20dc7 |
| cli-grpc-auth-block-parity | defect | **test** | real | cross-harness | #1088 → #1161 |
| cli-graphql-get-parity | defect | **test** | real | cross-harness | #1109 → #1161 |
| kafka-preset-registry-bearer | defect | **test** | real | cross-branch | #1127 after #1130 → #1153 |
| grpc-no-deadline-web-stream | defect | **test** | real | cross-harness | #1089 → #1152 |
| sse-post-body-web-unwired | defect | train | synthetic | cross-harness | none |
| sse-spec-signature-seam | defect | **test** | synthetic | cross-branch | none |
| mcp-conformance-anonymous-auth | defect | train | real | cross-consumer | #1134 → #1160 |
| mcp-stop-cleanup-unreachable | defect | train | real | cross-branch | #1126 over #1122 → #1160 |
| clean-cli-esm-require | control | train | real | none | #1155, no follow-up fix |
| clean-set-cookie-cap | control | **test** | real | none | #1158, no follow-up fix |
| clean-graphql-tab-fallback | control | train | real | none | #1156, no follow-up fix |
| clean-broker-preset-binding | control | **test** | real | none | #1159, no follow-up fix |
| clean-websocket-terminal-close | control | **test** | real | none | #1162 (source only), no follow-up fix |
| clean-mcp-import-header-handles | control | train | real | none | #1165 (source only), no follow-up fix |
| clean-electron-store-backup | control | **test** | real | none | #1164 (source only), no follow-up fix |
| clean-kafka-browse-bounds | control | train | real | none | #1154 (source only), no follow-up fix |

Every defect case so far comes from one two-week window (PRs #1088 to #1165, the post-merge
audit of 2026-10-25), and a third of them are MCP. That samples one period's failure
fingerprint, so when escaped defects are turned into cases, prefer a seam, protocol or harness
pair the suite does not cover yet (web Worker vs self-host Node, Kafka/MQTT, the collection
runner, importers) over another MCP or CLI-auth variant; the "Adding a case" section says how.

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
leakTerms: ['collapsed a panel']  # optional regexes: how the harness would word this case's lesson
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
traces through the symlinks produce on their own). A hit makes the run a graded failure
(`contaminated: true`, hits listed in the summary; see Grading).

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
- **The judge is not the model under test.** It defaults to `--judge-model claude-opus-5-5`,
  which is never the Sonnet the CI review jobs and the documented baseline commands use as the
  reviewer; set the reviewer with `--model`. When both name the same model, aliases included
  (`sonnet` is `claude-sonnet-5-5`), the runner warns before the run, and again after it from
  the ids the sessions actually used.
- **Judge consistency.** `--judge-repeat N` (1 or 3: odd, so the vote never ties) grades the
  same review N times. All verdicts are kept (`judge.verdicts`); the judge's `caught` is the
  strict majority and its score the mean. A run where the verdicts differ counts as a **judge disagreement**,
  per case and in total: that is grader noise, separate from reviewer flips.
- **Incomplete reviews are graded failures.** A review that runs out of budget
  (`error_max_budget_usd`, or a budget message on stderr), hits `error_max_turns`, or is killed by
  the review timeout counts as **not caught** for a defect and **not clean** for a control
  (against precision), with `incomplete: true` and the reason; the judge is not called. Excluding
  them would be survivorship bias: a configuration too slow or expensive to finish would look as
  good as one that finishes. The summary shows the incomplete count per case and in total.
- **Harness errors are not misses.** A run gets `status: "error"` with a reason, and is left out
  of recall and precision, when `claude` fails to start, exits non-zero or is killed by a signal
  other than the timeout, its output cannot be parsed (or the review stream has no `result`
  event), a finished review's answer is empty, the result reports `permission_denials`, another
  `error_*` subtype or `is_error`, stderr reports a tool that is not allowed or a permission
  denial, the overlay or a patch fails to apply, or the judge fails (including running out of
  budget). Errors are listed in the summary with the **error rate**; a high rate means the numbers
  describe the runs that happened to work, so fix the harness before reading them.
- **Contaminated reviews are graded failures too** (see Isolation): not caught for a defect, not
  clean for a control, `contaminated: true` with the hits, judge skipped, and counted in the
  summary ("Contaminated (graded as failures): N", plus a list). Excluding them would hide the
  cheating rate and let a configuration that peeks look no worse than one that does not. This
  matches the build eval.
- **A modified shared `node_modules` is an excluded error, and reported.** `nodeModulesFingerprint` hashes
  `node_modules/.package-lock.json`, `cli/node_modules/.package-lock.json` and the package.json
  and bin files of vitest and typescript before and after each review; a change fails the run
  ("reviewer modified shared node_modules — run npm ci in the main checkout") and prints a loud
  warning, because the links point into the main checkout and every later run would be affected.

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
  about 20 scored defect runs, the half-width is around 20 points. The **noise pre-flight**
  (printed before any model call and repeated in the summary) states this for the planned
  cases x runs at the worst case p = 0.5, and what it would take to reach 15 and 10 points.
- **Always failed**: cases that failed on every scored run. Anthropic's tell for a bad task is one
  that fails regardless of replicates: read its transcripts for ambiguity or an unfair grader
  (for example a fixture that does not type-check on its own, where a reviewer that reports the
  compile error and stops is behaving reasonably) before treating it as a harness gap.
- **Routing**: across review runs, how often each skill (Skill tool) and subagent (Task/Agent
  `subagent_type`) ran, by runs and calls. This is the signal for folding or pruning a reviewer:
  if `/ship-check` never routes to an agent, the agent is not what is catching the bugs.

### Transcripts

The review runs with `--output-format stream-json --verbose`; the raw stream of every run is
written to `<out>/<timestamp>--<config>/transcripts/<case>-run<k>.jsonl` and linked from the
per-case table (the judge stays `--output-format json`). Read them. A miss is only actionable once
you know whether the review never looked at the right file, looked and misjudged it, or hit a
harness problem; the aggregate cannot tell you which.

## Seen vs unseen

The overlaid harness encodes lessons learned from real incidents, and some of those incidents are
cases here (`docs/agents/delivery.md` mentions two MCP PRs that "together collapsed a panel";
`restura-parity-checker` cites #1131). A review that catches such a case may be recalling a
lesson written for it, not generalizing, so those cases are labelled rather than removed. Once per
invocation (dry runs included), `findOverlayLeaks` reads the overlay file set at the harness
commit (`git ls-tree` + `git show` over the overlay paths) and searches it for each case's terms:
its `sourcePRs` / `fixPRs` as `#NNNN` on a boundary, short commit SHAs (first 8 characters of
any SHA in those fields and of `sourceCommit`), and its own `leakTerms`. A case with any hit is
`seenInHarness: true` on every run, with the hits listed in the summary's "Seen in harness"
section, and the summary reports recall and precision for **all** cases and for **unseen** cases
only. Judge a harness change on the unseen numbers. A seen case in the **test** split prints
"held-out case is no longer unseen — move it to train or add a fresh case", because the test
split must stay unseen.

This is also the guard for the hillclimbing rule below: a round that writes a case-specific lesson
into skills, agents or CLAUDE.md turns that case "seen", and the summary shows it.

## Train / test split

Every case has a required `split` (the Cases table shows it). The held-out **test** split is
what the ADR 0033 gate reads, so it has to be large enough to show a change: about half the
cases (a unit test keeps it between 40% and 60%), always with controls and defects, and sized so
that a 3-run plan over it passes the noise pre-flight. Cases the harness already mentions
(`leakTerms` hits, "seen") stay in **train**: they measure memorisation. A case's split is
assigned when it is added and is not moved once results have been read against it. The split
was rebalanced on 2026-10-30 (from 6 to 10 held-out cases) before any baseline existed, so no
result had been read against the old split. `--split train|test|all` (default `all`) filters
the run.

Two uses, two rules (ADR 0033):

- **Regression gate** for any harness change (reviewer topology, skill descriptions, routing,
  vendored skills): run **all** cases at 3 runs against the committed baseline and read the
  per-case flips. Train cases count here too: leakage only matters once you have tuned on
  them. A change is kept when no defect case is newly missed on every run, no control is newly
  false-positive on every run, and recall and precision on unseen cases are not below the
  baseline's point estimate by more than the pre-flight half-width.
- **Hillclimb acceptance** for a change made to raise the numbers: iterate on **train**, confirm
  on **test**. Train up and test flat is suspected overfitting (revert); any regression on test
  (revert); both up (keep), where "up" means more than the half-width the pre-flight printed.

Hillclimbing rules, when you change skills, agents or CLAUDE.md to raise these numbers:

1. Before round one, read the noise pre-flight: if the smallest change you would act on is
   smaller than the half-width, add runs or cases first (the pre-flight says how many).
2. Read only **train** transcripts. Do not open test transcripts while iterating.
3. Propose **one root-cause change per round** (one skill/agent/prompt change, not a batch),
   large enough to show above the noise: rewrite the section that causes the miss or add the
   missing rule, not a reworded line.
4. Keep the change only if train improves **and** test does not regress (see the rules above).
5. Never paste failure content or case specifics (file names, symbols, the defect) into skills,
   agents or CLAUDE.md. Fix the behaviour, not the case.
6. **When the score stalls** for two rounds, or no single fix could gain more than the noise,
   stop editing and bucket every remaining train failure by cause: ambiguous or unfair case
   (fix or drop the case, say why in `notes`), harness error (fix the runner), run-to-run
   variance (add runs), legitimate miss (only these continue into further rounds). The summary
   already separates incomplete, contaminated, errored, judge-disagreement and always-failed
   runs; start from those lists.
7. Exclude a case as broken or ambiguous only after reading its transcripts, and say why in the
   case's `notes`.

### Cost is an objective

Every run records cost and minutes, and the flip report prints the mean cost and minutes per run
over the cases both sides share. "Hold recall and precision, cut cost" is a complete, well-scoped
hillclimb goal (it is the goal of every reviewer fold, and it still works when recall is
saturated): state it as such and read the cost line with the flips.

### Calibration: does the eval order models correctly?

A well-designed eval scores higher with a stronger model or more effort; if it does not, the
tasks are ambiguous or the judge is miscalibrated. Before the first baseline, and after any
change to the cases or the rubric, run the test split once with `--model claude-sonnet-5-5` and
once with `--model claude-opus-5-5` (same judge, same harness). Opus must score at or above
Sonnet on recall without worse precision. If it does not, read the always-failed and
judge-disagreement cases before trusting any number from this suite.

### Validating the judge

The judge is not the model under test (the runner warns when it is), and `--judge-repeat 3`
grades every review three times so grader noise shows up as **judge disagreements** rather than
as reviewer flips. `--save-baseline` turns that on by default. Once, on the first baseline, read
every judge verdict (`judge.verdicts[].reason` in the result JSON, next to the review text) and
note any you would have scored differently: scoring failures are the most common eval
misconfiguration, and a judge you have not read is a judge you are trusting blind. Record the
agreement count in the baseline PR.

## Baselines

`--save-baseline` additionally writes a **summary-only** JSON to
`evals/harness/baselines/<YYYY-MM-DD>T<HHMM>--<config>.json` (UTC start time, so same-day runs
never collide; the runner refuses to overwrite an existing file and checks before the run
starts): config, `harnessSha`, `claudeVersion` (from `claude --version`: results depend on the
CLI version, and a flip report across versions prints a warning), start time, runs per case,
models (requested and resolved), split, and per case caught /
runs / pass@1 / pass@n / pass^n / mean score / mean cost, plus recall and precision with CIs, the
pass@1 totals, the noise pre-flight and the routing counts. It contains no review text, judge reasons
or transcripts, so it is safe to commit, and it is how an A/B result outlives the gitignored
`.claude/metrics/`. `--compare` and the automatic flip report accept a full result or a baseline
file. See `baselines/README.md`.

ADR 0033 gates reviewer, routing and vendored-skill changes on "test split at or above the
baseline", so a committed baseline must exist before that rule can be applied. The cheapest way
to produce one is the `Eval harness` workflow: dispatch it with `save-baseline` ticked (test
split, 3 runs, `model` pinned, judge x3, default config `ci-<sha>`), download the
`eval-baseline-<run id>` artifact and commit the file in a chore PR. Re-baseline after every accepted harness change, and whenever the
pinned CLI version in `eval-harness.yml` is bumped.

## Running

```bash
npm run eval:harness -- --dry-run                 # validate cases, apply overlay + patches, check the combined merge; no model calls
npm run eval:harness -- --case mcp-panel-collapse # one case, 3 runs, config "current", harness = HEAD
npm run eval:harness -- --split train --runs 3    # hillclimb on train only
npm run eval:harness -- --cleanup                 # remove legacy harness-eval/* branches and worktrees
```

A/B comparison of two harness versions (same cases, same models, different harness commit):

```bash
npm run eval:harness -- --harness-ref main --config A --model claude-sonnet-5-5 --save-baseline
npm run eval:harness -- --harness-ref <branch> --config C --model claude-sonnet-5-5 --judge-repeat 3 \
  --compare evals/harness/baselines/<YYYY-MM-DD>T<HHMM>--A.json
```

Options:

- `--case <id>` (repeatable); `--split train|test|all` (default `all`).
- `--runs N` (1-20, default 3).
- `--config <label>` (default `current`; `[A-Za-z0-9._-]+` without `--`): recorded, names the
  output files and selects the previous result with exactly that config for the flip report.
- `--harness-ref <ref>` (default `HEAD` of the checkout running the script): the harness commit
  overlaid on every case base, resolved once per invocation.
- `--model <model>` (reviewer; default: the `claude` CLI default, which varies per machine and
  release, so `--save-baseline` requires it), `--judge-model <model>` (default
  `claude-opus-5-5`),
  `--judge-repeat 1|3` (default 1; 3 when `--save-baseline` is set), `--no-judge`. Every result
  also records the model ids the sessions actually used (`resolvedModels`, from the stream's
  init event and the result's `modelUsage`), and a comparison across different resolved models
  prints a warning.
- `--max-noise <pts>` (default 25): the widest worst-case recall CI half-width, in points, that
  `--save-baseline` accepts. The noise pre-flight prints the planned half-width before any model
  call and refuses a noisier baseline; raise this deliberately, or add runs or cases.
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
   them. For a defect, `npm run eval:new-case -- --from <fixPR#> [--id <id>]` does the
   lookup (read-only `gh pr view` + git): it guesses the introducing PRs from the fix's `#nnn`
   references, proposes `base` as the first one's merge parent, writes a `cases/<id>.yaml`
   skeleton full of TODOs (it never overwrites a case) and prints the `git diff` commands for
   step 2. Check its guesses; it only reads references. For a control, pick a small merged PR
   and confirm `git log <merge>..origin/main -- <its files>` is empty (or that every later
   commit there is unrelated: read them), so nothing later fixed it.
2. In a scratch worktree at that commit, apply the introducing diff restricted to source files
   (`git diff <base> <merge> -- <files> | git apply`), trim it to the relevant hunks, and save
   `git diff --cached` as `fixtures/<id>/NN-name.patch`. Keep each patch under about 300 lines;
   split a branch into several patches if needed.
3. Write `cases/<id>.yaml`, then run `npm run eval:harness -- --dry-run --case <id>`.
4. Mark anything invented as `origin: synthetic`.
5. Give it a `split` before running it, keeping the test share near half with controls and
   defects held out, and seen cases (`leakTerms` hits) in train (see "Train / test split").
   Never move a case between splits after its results have been seen.
6. Prefer breadth over depth: say in one line why the case is hard before adding it (a human
   judgement, not "the current model fails it"), and favour a seam, protocol or harness pair
   the table does not cover yet over another variant of one it does. A suite drawn from one
   incident window measures that window's failure fingerprint, not what is intrinsically hard.
