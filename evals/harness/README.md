# Harness eval: does the review pipeline catch seam bugs?

Restura's worst bugs this year were **seam bugs**: PRs that were green alone but broken together,
or a change wired into one harness (web Worker / Electron / CLI) or one consumer and not the
other. This suite measures whether the review entry point (`/ship-check --quick <branches>`,
with its parity / security / docs agents and the integration check) catches them, and whether
it raises false alarms on PRs that were fine. Run it as a baseline before changing the reviewer
setup, for example before folding the parity or docs subagents into main-loop skills.

The design follows Anthropic's guidance on agent evals: a small set of golden cases, graded on
the final answer with a rubric, each run at least twice, reporting per-case flips and not only
the aggregate.

## Layout

```
evals/harness/
  cases/<id>.yaml          one case per file (schema below)
  fixtures/<id>/*.patch    the branch(es) as they were BEFORE the fix (minimised), or a clean PR
  rubric.md                LLM judge rubric (defect and control sections)
scripts/harness-eval.mjs   runner
```

## Cases

| id | type | origin | seam | source → fix |
|---|---|---|---|---|
| mcp-panel-collapse | defect | real | cross-branch | #1133 + #1134 → #1150 |
| mcp-runner-auth-override | defect | real | cross-consumer | #1131 → #1151 |
| cli-auth-double-expansion | defect | real | cross-consumer | #1163 (commits 1-2) → #1163 (commit 3) |
| sigv4-interactive-send-dropped | defect | real | cross-consumer | c6c751c2 → 115b64f1 / 0ef20dc7 |
| cli-grpc-auth-block-parity | defect | real | cross-harness | #1088 → #1161 |
| cli-graphql-get-parity | defect | real | cross-harness | #1109 → #1161 |
| kafka-preset-registry-bearer | defect | real | cross-branch | #1127 after #1130 → #1153 |
| grpc-no-deadline-web-stream | defect | real | cross-harness | #1089 → #1152 |
| sse-post-body-web-unwired | defect | synthetic | cross-harness | none |
| sse-spec-signature-seam | defect | synthetic | cross-branch | none |
| clean-timeline-flush-cost | control | real | none | #1157, no follow-up fix |
| clean-set-cookie-cap | control | real | none | #1158, no follow-up fix |

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
expectClean: false        # true for a control
sourcePRs: ['#1133']      # required for real cases
fixPRs: ['#1150']         # optional
base: <40-char SHA>       # the branches are cut from here
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
`(\bGET\b|web)`), because it would credit a review that never located the bug.

## Grading

- **Defect case**: `caught` only when the rubric judge says caught **and** an anchor pattern
  matches. The run records the judge's verdict (`judgeCaught`) and the anchor match
  (`patternCaught`) separately, and the summary counts judge-only and pattern-only runs so
  disagreements between the two graders show up. With `--no-judge`, every `mustMention`
  pattern must match.
- **Control** (`expectClean: true`): `caught` means the review reported no high or medium
  defect in the fixture's files, according to the judge's control rubric. Controls need the
  judge.
- **Harness errors are not misses.** A run gets `status: "error"` with a reason, and is left out
  of recall and precision, when `claude` exits non-zero or is killed, its JSON cannot be parsed,
  the JSON reports `permission_denials`, an `error_*` subtype (budget, max turns) or `is_error`,
  stderr reports a tool that is not allowed, a permission denial or budget exhaustion, a patch
  fails to apply, or the judge fails. Errors are listed in the summary.

The summary reports **recall on defect cases**, **control precision** (clean / false
positives), the error count, and a per-case table.

## Running

```bash
npm run eval:harness -- --dry-run                 # validate cases, apply patches, check the combined merge; no model calls
npm run eval:harness -- --case mcp-panel-collapse # one case, 2 runs, config "current"
npm run eval:harness -- --runs 3 --config skills  # label a reviewer configuration for A/B comparison
npm run eval:harness -- --cleanup                 # remove harness-eval/* branches and worktrees left by a crashed run
```

Options: `--case <id>` (repeatable), `--runs N` (default 2), `--config <label>` (default
`current`; recorded only, so later runs can be compared), `--dry-run`, `--out <dir>` (default
`.claude/metrics/evals/`, gitignored), `--no-judge`, `--judge-model <model>`,
`--max-budget-usd <n>` (per review run, default 20), `--compare <result.json>` (flip report
against a specific earlier result, for example another config), `--cleanup`.

For each run the runner:

1. adds a throwaway worktree at `base` and creates `harness-eval/<run-id>/<branch>` from the
   patches, then checks that all branches merge together without a textual conflict (the
   defect must be semantic);
2. links `node_modules` (`scripts/worktree-setup.mjs`) and runs
   `claude -p --output-format json` with `/ship-check --quick <branches>` plus a note to treat
   `base` as `main`. The prompt is the same for defect cases and controls and never hints at
   the outcome. Tools are limited to Bash, Read, Grep, Glob, Task and Skill, with `git push`
   and `gh` denied, and `--max-budget-usd` caps each review;
3. grades the final text (see Grading);
4. always removes the worktree and the branches. SIGINT/SIGTERM stop the child, run the same
   cleanup and exit non-zero (130 / 143). `--cleanup` handles a hard crash: it removes only
   branches under `harness-eval/` and worktrees under this tool's `restura-harness-eval-*`
   temp dirs.

Each invocation writes `<timestamp>--<config>.json` and `.md`. When an earlier result for the
same config exists (or `--compare` is given), the summary includes a **flip report**: cases,
defect or control, whose caught rate over scored runs changed. The per-case table also flags
cases whose runs disagreed within one invocation.

A full run is 12 cases x 2 runs of `/ship-check --quick`, plus 24 judge calls. That is slow and
costs real money, so run it deliberately.

## Adding a case

1. Find the incident: the fix PR, the PR(s) that introduced it, and the main commit before
   them. For a control, pick a small merged PR with no later fix to its files.
2. In a scratch worktree at that commit, apply the introducing diff restricted to source files
   (`git diff <base> <merge> -- <files> | git apply`), trim it to the relevant hunks, and save
   `git diff --cached` as `fixtures/<id>/NN-name.patch`. Keep each patch under about 300 lines;
   split a branch into several patches if needed.
3. Write `cases/<id>.yaml`, then run `npm run eval:harness -- --dry-run --case <id>`.
4. Mark anything invented as `origin: synthetic`.
