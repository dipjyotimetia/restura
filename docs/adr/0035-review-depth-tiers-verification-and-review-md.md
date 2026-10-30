# ADR 0035: Review Depth Tiers, Verification Vote and `REVIEW.md`

**Status:** Proposed, 2026-10-30 (pending the before/after eval run required by ADR 0033)

## Context

[ADR 0033](./0033-evals-gate-harness-changes.md) forked the vendored `code-review` skill into a repo-owned three-axis review (Correctness, Standards, Spec). Four problems remained:

- **Same cost for every diff.** A one-line copy change and a cross-harness protocol change both started three sub-agents, each carrying a ~1k-token smell baseline and the full brief pasted into its prompt.
- **No confidence filter.** A correctness finding went straight into the report. With agent authors a false alarm is not a nit someone dismisses in seconds: the author commits a "fix" and triggers another round.
- **No round control.** Nothing stopped a reviewer and an agent author from looping, nothing stopped the same finding being posted twice, and later rounds re-reviewed the whole diff.
- **Reviewer knowledge lived in the skill.** What failure looks like per area, which paths to skip, and how many nits are acceptable were either implicit or scattered.

Anthropic's account of its own review pipeline ("How the Claude Code team does code review") describes the fixes that moved its internal convergence from 65% to 78% of PRs passing after one round: a code-owner `REVIEW.md`, multi-agent fan-out with a separate verification vote, severity filtering with `Important` / `Nit` / `Pre-existing` tags, review depth tiers per risk, no repeated findings, diff-only re-review and a round cap.

## Decision

1. **`REVIEW.md` at the repo root** is the code-owner brief every reviewer loads: a per-area table of what failure looks like (diverges, is silent, bypasses, is unvalidated, leaks, rots, lies), the evidence rule (`file:line` actually read plus a concrete scenario; never a guess from a name), tag definitions, caps (5 Nits grouped by class, 3 Pre-existing), paths to skip, the Deep-tier path list and the round rule. The `code-review` skill, `/ship-check` and both CI review jobs follow it, and the eval harness overlays it with the rest of the harness.
2. **Depth is chosen from the diff, not the author.** Quick (< 200 changed lines, no Deep path: one sub-agent, no verifier), Standard (three axes in parallel, one verifier) and Deep (any `REVIEW.md` Deep path or > 800 lines: two correctness hunters with different emphasis, two independent verifiers). The caller can override with `--depth`.
3. **Important findings are verified before they are posted.** Verifiers see only the finding list, open the cited code and answer `CONFIRMED` / `REJECTED` / `DOWNGRADE` per finding. Standard posts what its one verifier confirms; Deep posts what both confirm and lists one-of-two agreement as non-blocking `Unconfirmed`. Rejected findings are counted, not listed.
4. **Severity tags and filters.** Correctness drops style, diagnostics and cleanup; Standards owns them under the Nit cap. `Pre-existing` is never blocking. The `Important (blocking)` wording is kept because `/ship-check`, CI and the eval judge key on it.
5. **Rounds.** Round 2+ reviews the diff since the last reviewed sha plus previously flagged lines, carries prior findings in every sub-agent header so none is repeated, and at round 3 the report asks for a rethink instead of another patch. `babysit-prs` stops pushing fixes after three rounds; the CI label re-run counts earlier skill-review comments as rounds.
6. **Token discipline.** The parent reads only `REVIEW.md` and a `--stat`; sub-agents receive a short header and read their brief (`references/briefs.md`), the smell baseline (`references/smells.md`) and the code from disk. The diff command excludes generated and evidence-only paths. `SKILL.md` shrank from 102 to about 70 lines and no longer carries the smell list.

### Alternatives considered

- **Keep three full sub-agents for every diff.** Rejected: most small diffs come back clean, and three agents reading one pasted baseline each is the cost that made reviews skipped.
- **N-of-M voting on every finding at every depth.** Rejected for cost: verification is scoped to Important findings and to one or two voters, which is where a false alarm costs a fix round.
- **A separate verifier per finding.** Rejected: one verifier takes the whole list with the same independence and far fewer prompt tokens.
- **Putting the per-area failure table into `CLAUDE.md`.** Rejected: `CLAUDE.md` loads on every turn and keeps invariants only (ADR 0032); review-only knowledge belongs in a file loaded by reviews.

## Consequences

- ADR 0033 applies: this is a reviewer-topology change, so it needs a before/after `npm run eval:harness --harness-ref` comparison (at least 2 runs per case) against the committed baseline before the status moves to Accepted. Control cases should improve (verification cuts false alarms); defect cases must not regress. The routing suite gains a positive `code-review` case.
- Reviews are cheaper on small diffs and more expensive on Deep paths, which is the intended shape.
- CI and local reviews share one rulebook (`REVIEW.md`), so a recurring false alarm or a missed class is fixed there once.
- Depth is a heuristic on line counts and paths; a small change on a non-Deep path that still matters can be forced with `--depth deep`.

## References

- Code: `.claude/skills/code-review/SKILL.md`, `.claude/skills/code-review/references/{briefs,smells}.md`, `REVIEW.md`, `.claude/skills/ship-check/SKILL.md`, `.claude/skills/babysit-prs/SKILL.md`, `.github/workflows/claude-code-review.yml`, `scripts/harness-eval.mjs` (overlay), `evals/routing/cases.yaml`
- Related: [ADR 0032 (agent harness)](./0032-agent-harness-evals-hooks-progressive-disclosure.md), [ADR 0033 (evals gate harness changes)](./0033-evals-gate-harness-changes.md)
- Source: Anthropic, "How the Claude Code team does code review" (claude.dev/blog/solving-code-review-at-anthropic)
