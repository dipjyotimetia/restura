---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base; defaults to the merge-base with origin/main) along three axes: Correctness (bugs, edge cases, error paths, races, and Restura seam breaks across renderer/Worker/Electron/CLI), Standards (does the code follow this repo's documented coding standards?) and Spec (does it match the originating issue/spec?). Picks a Quick/Standard/Deep depth from the diff, runs the axes in parallel sub-agents, verifies Important findings before posting them, and reports them side by side tagged Important / Nit / Pre-existing. Non-interactive safe. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\". This is the canonical code review for this repo (prefer it over generic plugin code-review skills); /ship-check calls it as the fresh-context review pass."
argument-hint: '[fixed-point] [--depth quick|standard|deep] [--round n] [--prior <file>] [--spec <path>] [--include-uncommitted]'
allowed-tools: Bash, Read, Grep, Glob, Agent, Task
---

<!-- Forked from mattpocock/skills `code-review` (Standards + Spec axes); extended for Restura
     with a Correctness axis, depth tiers, a verification vote and REVIEW.md. Maintained locally,
     not tracked in skills-lock.json. ADR 0033 gates changes to it with the eval harness. -->

Three-axis review of the diff between `HEAD` and a fixed point: **Correctness** (does it work, including at the seams where Restura's harnesses meet), **Standards** (does it follow the repo's documented standards) and **Spec** (does it do what was asked). Axes run as parallel sub-agents so they do not pollute each other; this skill scopes the diff, picks the depth, verifies, and aggregates.

**Never ask the user questions.** This runs inside `/ship-check`, `/batch-ship` and CI (`claude-skill-review`), where nobody answers. Every step has a default; take it and name it in the report.

**Token discipline.** The parent reads nothing but `REVIEW.md` and the diff stat. Sub-agents receive a header (fixed point, diff command, brief name, prior findings) and read their own brief from `references/briefs.md`, `REVIEW.md` and the code themselves. Never paste the diff, the briefs or `references/smells.md` into a prompt.

## Process

### 1. Pin and scope the diff

Fixed point: the caller's (`<sha>`, branch, tag, `HEAD~5`, a PR base). Default `git merge-base HEAD origin/main`, then `main`. Confirm it resolves (`git rev-parse`). Build the diff command once, with the skip paths from `REVIEW.md`:

```bash
git diff <fixed-point>...HEAD -- . ':(exclude)package-lock.json' ':(exclude)openwiki/**' ':(exclude)docs/CAPABILITY_MATRIX.md' ':(exclude)shared/opencollection/spec-types.ts' ':(exclude)e2e/mocks/proto/gen/**' ':(exclude)**/*.generated.ts' ':(exclude)**/*.snap' ':(exclude)evals/harness/fixtures/**' ':(exclude)evals/harness/baselines/**' ':(exclude)vendor/**'
```

Also `git log <fixed-point>..HEAD --oneline`; add `git diff HEAD` with the same excludes when `--include-uncommitted`. Run the command with `--stat` only. An unresolved ref or an empty scoped diff ends the review here with a one-line report, never inside sub-agents.

### 2. Pick the depth

From the diff stat, not the author. The caller's `--depth` wins.

| Depth | When | Sub-agents |
|---|---|---|
| **Quick** | < 200 changed lines and no Deep path touched | one `quick` agent (all axes, separate headings); no verifier |
| **Standard** | everything else | `correctness`, `standards`, `spec` in parallel; one `verify` pass on Important findings |
| **Deep** | any path in `REVIEW.md` "Review depth", or > 800 changed lines | two `correctness` agents (bugs / seams emphasis), `standards`, `spec`; two independent `verify` agents |

### 3. Find the spec and the standards

Spec, in order: issue references in commits or the PR body (`gh issue view <n>`, per `docs/agents/issue-tracker.md`); `--spec <path>`; a file under `docs/`, `specs/` or `.scratch/` matching the branch. None → skip the Spec axis and say "no spec available".

Standards list: `CLAUDE.md`/`AGENTS.md`, `docs/agents/architecture.md`, the relevant `docs/adr/*`, and `.claude/skills/restura-feature-dev/references/*` when the diff touches a feature or protocol; `CODING_STANDARDS.md` / `CONTRIBUTING.md` whenever they exist. Pass paths, not contents.

### 4. Rounds (re-reviews)

Round 1 unless `--round n` or the caller supplies prior findings (`--prior <file>`: `file:line — summary` lines, e.g. parsed from earlier review comments). From round 2: the diff is `git diff <last-reviewed-sha>...HEAD` with the excludes, plus the previously flagged lines; prior findings go in every header so nothing is repeated. At round ≥ 3 the report's first line states the round cap is reached and recommends reconsidering the approach instead of another fix round.

### 5. Fan out

One message, all sub-agent calls together, foreground. Each gets the header from `references/briefs.md` ("Header the parent supplies") and the brief name; at Deep, the second correctness agent's header says `Emphasis: seams and combinations`. Include any overlap matrix or per-branch diffs the caller supplied (e.g. from `npm run integration-check`) under `Extra context`.

### 6. Verify (Standard and Deep)

Collect the Important findings from the correctness agent(s), de-duplicated by `file:line` and mechanism. If none, skip. Otherwise run the `verify` brief: one agent at Standard, two independent agents at Deep, each with only the finding list in its header. Post as **Important** only what the vote allows: Standard, CONFIRMED; Deep, CONFIRMED by both. Apply DOWNGRADE verdicts. A Deep finding confirmed by one of two goes under `Unconfirmed` at the end of Correctness, non-blocking. REJECTED findings are dropped and counted in the summary line, not listed.

### 7. Aggregate

```
# Review — <total> findings (<i> Important, <n> Nit, <p> Pre-existing) · depth <tier> · round <r>
<"Nothing to fix." when total is 0, or the round-cap line at round ≥ 3>

## Correctness
<findings, Important first, verifier verdict appended as "(verified 2/2)"; then Unconfirmed>
## Standards
## Spec
<or "no spec available">

Defaults taken: fixed point <ref>, spec <source|none>, depth <tier> (<why>), <k> findings rejected by verification.
```

Keep the sub-agents' lines verbatim or lightly cleaned. Do **not** merge or rerank across axes, and do not pick a single winner across them: a change can pass one axis and fail another (works on web and silently breaks on desktop → Standards and Spec pass, Correctness fails), and reporting them separately stops one axis from masking another. Within Correctness keep severity order and the `Important (blocking)` wording: `/ship-check` and CI treat those as merge blockers, and the eval harness grades on them. Enforce the `REVIEW.md` caps (5 Nits grouped by class, 3 Pre-existing) when a sub-agent exceeds them.
