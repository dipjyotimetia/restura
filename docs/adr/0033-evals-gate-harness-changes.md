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

## References

- Code: `scripts/harness-eval.mjs`, `scripts/routing-eval.mjs`, `scripts/eval-new-case.mjs`, `scripts/build-eval.mjs`, `evals/`, `.github/workflows/eval-harness.yml`, `.claude/skills/code-review/SKILL.md`, `skills-lock.json`
- Related: [ADR 0032 (agent harness)](./0032-agent-harness-evals-hooks-progressive-disclosure.md), [ADR 0021 (maintenance harness)](./0021-maintenance-harness.md), [ADR 0028 (architecture boundaries and ratchets)](./0028-typescript-architecture-boundaries.md)
