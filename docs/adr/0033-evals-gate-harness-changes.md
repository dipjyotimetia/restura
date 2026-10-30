# ADR 0033: Evals Gate Harness Changes

**Status:** Accepted, 2026-10-25

## Context

[ADR 0032](./0032-agent-harness-evals-hooks-progressive-disclosure.md) put an eval suite in front of any restructuring of the reviewer agents, and the suite now exists: seam-bug cases with a train/test split, a routing suite, a build-loop suite, and a label-gated workflow. What the ADR did not settle is the rule that makes the suite binding. Without one, the next fold, removal or skill rewrite is judged by intuition, and two risks follow:

- **Silent regressions.** A skill description edit can stop a skill from loading, and a folded reviewer can stop catching the seam bugs it caught before. Neither shows up in a diff.
- **Overfitting.** Tuning skills against the cases that failed makes those cases pass without making the harness better, and a model that can read git history can read the fix.

The vendored `code-review` skill also reviewed on two axes (Standards, Spec) and had no correctness pass, and ten vendored skills were never invoked in the usage log.

## Decision

1. **Evals gate harness changes.** Any change to reviewer topology (folding, removing or forking reviewer agents or skills), to skill descriptions or routing, or to the vendored-skill set needs a before/after eval on the same harness. Run `--harness-ref` A (before) against C (after) with at least 2 runs per case, and report per-case flips and test-split pass@1 with its confidence interval. Keep the change only if the test split is at or above the baseline and the difference is not within noise.
2. **Hillclimb on train, report on test.** Iterate against the train split only. Never encode case specifics (file names, bug descriptions, fixture wording) into skills.
3. **Isolation.** Evals run in a history-free repo with the harness under test overlaid, so a model cannot read the fix from git. Runs that were contaminated (harness failures, permission denials, history access) are excluded from scores.
4. **Escaped defects become cases.** A defect that reached `main` past the harness is turned into an eval case within a week (`npm run eval:new-case -- --from <fixPR#>`).
5. **Applied now.** The vendored `code-review` skill is forked into a repo-owned skill with three axes (Correctness, Standards, Spec) that lives outside `skills-lock.json`, and ten unused vendored skills are pruned.

### Alternatives considered

- **Per-PR evals.** Rejected. A review eval costs real model usage per case per run; a label-gated, on-demand workflow gives the signal at the moment a harness change is proposed.
- **Aggregate score only.** Rejected. One pass rate hides flips: a change can fix one case and break another with the total unchanged. The per-case flip report is the evidence.
- **Fold reviewers without a baseline.** Rejected. This is the regression ADR 0032 warns about.
- **Keep the vendored `code-review`.** Rejected. Updates to a vendored skill overwrite local changes, and it lacked a correctness axis.

## Consequences

- Harness changes become slower and cost money: each reviewer, routing or vendored-skill change carries an eval run. The `eval-harness` label on a same-repo PR (or a manual dispatch) runs it in CI with a per-run budget cap; it is never a required check.
- The skill set can shrink with evidence. Pruned skills can come back if a routing case needs them.
- CI and local review are not identical, and the READY marker accounts for that. The automatic `claude-review` job in `claude-code-review.yml` runs the `code-review@claude-code-plugins` plugin; the label-triggered `claude-skill-review` job runs the repo's three-axis `code-review` skill, which is what `/ship-check` runs locally. The automatic job is skipped only when a `/ship-check` READY marker is bound to the head sha, i.e. when the repo skill (Correctness included) already reviewed that exact commit; the `claude-review` label always forces both.
- Cases must be maintained: escaped defects add cases, and saturated cases are retired in `/triage-maintenance`.

### Amendment 2026-10-30

A review of the harness found the gate in rule 1 had never been applied: no baseline was committed
under `evals/harness/baselines/`, so "at or above the baseline" had nothing to compare against,
and results did not record the Claude Code CLI version although the CI workflow pins one because
results depend on it. Changes:

- Every harness, routing and build-eval result (and every baseline) records `claudeVersion` from
  `claude --version`; a flip report across two versions prints a warning, because such flips may be
  version noise rather than harness change.
- The `Eval harness` workflow has a `save-baseline` input that writes and uploads a summary-only
  baseline to commit, so the first baseline (and each re-baseline after an accepted change or a CLI
  bump) does not depend on one developer's machine. A committed baseline is a prerequisite for a
  reviewer, routing or vendored-skill change, not an optional extra.
- The workflow runs the reviewer inside the Claude Code sandbox with a strict egress allowlist
  (Claude API and OAuth hosts, npm registry; never github.com), because `--disallowedTools` is
  not a sandbox and the job holds a Claude token.
- Routing cases now exist for every model-invocable skill (the eight that had none were added, with
  matching negatives), so a description edit that stops any skill from loading is measurable.
- Noted for future "why did CI miss this" questions: the CI review jobs pass `--model
  claude-sonnet-5-5`, so the `model: inherit` reviewer agents (security auditor, parity checker)
  also run on Sonnet in CI, while a local `/ship-check` inherits the developer's model. The evals
  measure whichever `--model` they are given; compare like with like.

Still open: the loops themselves (`/fix-until-green`, `/verify-ui-change`, `/batch-ship`
orchestration) have routing cases but no outcome eval; the build eval covers the main loop only.

### Amendment 2026-10-30 (b): the gate as written could not be satisfied

A second review, against Anthropic's eval-design guidance, found that rule 1 could never pass:
the held-out split was 3 defect cases and 3 controls, so at 2 runs a perfect test result had a
95% CI of 61% to 100% recall, and "not within noise" was unreachable for any change. It also
found that the reviewer model was neither pinned nor recorded, the judge's own noise was not
measured by default, nothing checked that the eval orders models correctly, cost was recorded but
never read, and the review prompt announced itself as an eval. Changes:

- **Two rules instead of one.** The **regression gate** for any harness change (reviewer
  topology, skill descriptions or routing, the vendored-skill set) runs **all** cases at 3 runs
  against the committed baseline. Train cases count: leakage only matters once you have tuned
  on them. The change is kept when no defect case is newly missed on every run, no control is
  newly false-positive on every run, and unseen recall and precision are not below the baseline
  by more than the pre-flight half-width. **Hillclimb acceptance** for a change made to raise
  the numbers follows the guidance's decision rule: iterate on train, confirm on test; train up
  and test flat is overfitting (revert), any test regression (revert), both up by more than the
  noise (keep).
- **The test split carries the gate, so it was rebalanced** from 6 to 10 of 20 cases (6 defects,
  4 controls) before any baseline existed; cases the harness already mentions stay in train. A
  unit test holds the share between 40% and 60% and requires a 3-run plan over the test split to
  clear the noise pre-flight.
- **Noise pre-flight.** The runner prints, before any model call, the worst-case recall and
  precision CI half-widths for the planned cases x runs and the trials needed to reach 15 and 10
  points. `--save-baseline` refuses a plan wider than `--max-noise` (25 points). The default
  `--runs` is 3.
- **Pinned and recorded models.** `--save-baseline` requires an explicit `--model`; every result
  and baseline records the model ids the sessions actually used (`resolvedModels`, from the
  stream's init event and `modelUsage`), and a comparison across different resolved models warns.
  The workflow exposes `model`, `judge-model` and `judge-repeat`, pinned by default to the Sonnet
  the CI review jobs use.
- **Judge noise measured by default, judge read once by a human.** A baseline grades each review
  three times (`--judge-repeat 3`), and the first baseline's PR records a human read-back of the
  verdicts and a **calibration run**: a stronger reviewer (Opus) must score at or above a weaker
  one (Sonnet) on recall without worse precision, else the cases or the judge are wrong.
- **Always-failed cases are suspect first.** The summary lists cases that failed every scored run;
  `/triage-maintenance` treats a case always-failed across two baselines as a case problem to
  read before it is a harness gap, and hillclimbing that stalls for two rounds buckets the
  remaining failures by cause before another edit.
- **Cost is an objective.** The flip report prints mean cost and minutes per run over the shared
  cases; "hold recall and precision, cut cost" is the stated goal of a reviewer fold.
- **No eval announcement** in the review prompt, and new cases prefer seams the suite does not
  cover (every defect so far comes from one two-week window).

Still open: a 20-case suite cannot reach a 10-point half-width at any affordable run count; the
cure is cases, added as defects escape, not more rounds.

## References

- Code: `scripts/harness-eval.mjs`, `scripts/routing-eval.mjs`, `scripts/eval-new-case.mjs`, `scripts/build-eval.mjs`, `evals/`, `.github/workflows/eval-harness.yml`, `.claude/skills/code-review/SKILL.md`, `skills-lock.json`
- Related: [ADR 0032 (agent harness)](./0032-agent-harness-evals-hooks-progressive-disclosure.md), [ADR 0021 (maintenance harness)](./0021-maintenance-harness.md), [ADR 0028 (architecture boundaries and ratchets)](./0028-typescript-architecture-boundaries.md)
