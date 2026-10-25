# Harness eval: does the review pipeline catch seam bugs?

Restura's worst bugs this year were **seam bugs**: PRs that were green alone but broken together,
or a change wired into one harness (web Worker / Electron / CLI) or one consumer and not the
other. This suite measures whether the review entry point (`/ship-check <branches>`, with its
parity / security / docs agents and the integration check) catches them. It is the baseline to
run before changing the reviewer setup, for example folding the parity or docs subagents into
main-loop skills.

The design follows Anthropic's guidance on agent evals: a small set of golden cases, graded on
the final answer with a rubric, each run at least twice, reporting per-case flips and not only
the aggregate.

## Layout

```
evals/harness/
  cases/<id>.yaml          one case per file (schema below)
  fixtures/<id>/*.patch    the branch(es) as they were BEFORE the fix, minimised
  rubric.md                LLM judge rubric (score 0-3, caught = score >= 2)
scripts/harness-eval.mjs   runner
```

## Cases

| id | origin | seam | source → fix |
|---|---|---|---|
| mcp-panel-collapse | real | cross-branch | #1133 + #1134 → #1150 |
| mcp-runner-auth-override | real | cross-consumer | #1131 → #1151 |
| cli-auth-double-expansion | real | cross-consumer | #1163 (commits 1-2) → #1163 (commit 3) |
| sigv4-interactive-send-dropped | real | cross-consumer | c6c751c2 → 115b64f1 / 0ef20dc7 |
| cli-grpc-auth-block-parity | real | cross-harness | #1088 → #1161 |
| cli-graphql-get-parity | real | cross-harness | #1109 → #1161 |
| kafka-preset-registry-bearer | real | cross-branch | #1127 after #1130 → #1153 |
| grpc-no-deadline-web-stream | real | cross-harness | #1089 → #1152 |
| sse-post-body-web-unwired | synthetic | cross-harness | none |
| sse-spec-signature-seam | synthetic | cross-branch | none |

Real cases are reconstructed from `docs/audits/post-merge-review-2026-10-25.md` and git
history. Each `base` is the main commit the original branch was cut from (or merged onto), and
the patches are that branch's source hunks with tests, docs and unrelated files removed. Each
case's `notes` field says what was elided.

### Case schema

```yaml
id: kebab-case, equal to the file name
title: one line
origin: real | synthetic
sourcePRs: ['#1133']      # required for real cases
fixPRs: ['#1150']         # optional
base: <40-char SHA>       # the branches are cut from here
seam: cross-branch | cross-harness | cross-consumer
branches:                 # 1-3; each patch is applied and committed in order
  - name: feat/x
    patches: [01-a.patch]
expected:
  defect: what breaks and why (fed to the judge only, never to the reviewer)
  files: [paths a correct review must cite]
  symbols: [optional]
mustMention: [case-insensitive regexes the final answer must all match]
mustNotMiss: critical | high | medium | low
notes: minimisation notes
```

## Running

```bash
npm run eval:harness -- --dry-run                 # validate cases, apply patches, check the combined merge; no model calls
npm run eval:harness -- --case mcp-panel-collapse # one case, 2 runs, config "current"
npm run eval:harness -- --runs 3 --config skills  # label a reviewer configuration for A/B comparison
```

Options: `--case <id>` (repeatable), `--runs N` (default 2), `--config <label>` (default
`current`; recorded only, so later runs can be compared), `--dry-run`, `--out <dir>` (default
`.claude/metrics/evals/`, gitignored), `--no-judge` (grade by `mustMention` only),
`--judge-model <model>`, `--max-budget-usd <n>` (per review run, default 20), `--compare
<result.json>` (flip report against a specific earlier result, for example another config).

For each run the runner:

1. adds a throwaway worktree at `base` and creates `harness-eval/<run-id>/<branch>` from the
   patches, then checks that all branches merge together without a textual conflict (the
   defect must be semantic);
2. links `node_modules` (`scripts/worktree-setup.mjs`) and runs
   `claude -p --output-format json` with `/ship-check <branches>` plus a note to treat `base`
   as `main`; the prompt never mentions the defect. Tools are limited to Bash, Read, Grep,
   Glob, Task and Skill, with `git push` and `gh` denied;
3. grades the final text with the `mustMention` regexes and with the rubric judge
   (`claude -p`, no tools), and records both. `caught` comes from the judge when it returned a
   verdict, otherwise from `mustMention`;
4. always removes the worktree and the branches.

Each invocation writes `<timestamp>--<config>.json` and `.md`. When an earlier result for the
same config exists (or `--compare` is given), the summary includes a **flip report**: cases
whose caught rate changed. The summary also flags cases whose runs disagreed within one
invocation.

A full run is 10 cases x 2 runs of a complete `/ship-check`, plus 20 judge calls. That is slow
and costs real money, so run it deliberately.

## Adding a case

1. Find the incident: the fix PR, the PR(s) that introduced it, and the main commit before
   them.
2. In a scratch worktree at that commit, apply the introducing diff restricted to source files
   (`git diff <base> <merge> -- <files> | git apply`), trim it to the relevant hunks, and save
   `git diff --cached` as `fixtures/<id>/NN-name.patch`. Keep each patch under about 300 lines;
   split a branch into several patches if needed.
3. Write `cases/<id>.yaml`, then run `npm run eval:harness -- --dry-run --case <id>`.
4. Mark anything invented as `origin: synthetic`.
