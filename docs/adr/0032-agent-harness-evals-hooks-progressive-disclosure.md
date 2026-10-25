# ADR 0032: Agent Harness — Evals First, Hook-Enforced Rules, Progressive Disclosure

**Status:** Accepted, 2026-10-25

## Context

[ADR 0021](./0021-maintenance-harness.md) gave Restura an agent harness of skills, three reviewer subagents, slash commands and one measurement hook. Two weeks of agent-driven delivery (72 PRs) then showed where it fell short:

- **Seam bugs got through.** PRs that were green individually broke `main` together: two MCP PRs collapsed a panel, a second auth path overwrote the first, two branches both added `{{var}}` resolution, and the CLI shipped without parity. Each was invisible in a per-branch review.
- **Rules were prose.** "Never `git add -A`", "subagents don't push", "`--admin` is emergencies only" and "inline snapshots only" lived in CLAUDE.md and agent briefs. A stray `node_modules` symlink reached `main`, and `--admin` became routine.
- **The harness was never measured.** `skill-usage.log` recorded invocations, not outcomes. The structured loops (`/batch-ship`, `/ship-check`, `/fix-until-green`) did not appear in the log at all, and each `/ship-check` started four review agents per branch (about 20 for a five-PR batch).
- **Context cost.** CLAUDE.md had grown to 310 lines, mostly subsystem detail loaded on every turn, and AGENTS.md mirrored it.
- **Worktrees accumulated:** 73 linked worktrees by 2026-10-25.

Anthropic's guidance on agent design ("when to fold subagents into your main agent loop") recommends one loop with progressive disclosure, hard limits in tools and hooks rather than prompts, subagents only where a fresh context pays (parallel work, black-box verification), and task-completion evals **before** restructuring agents.

## Decision

1. **Evals first.** `evals/harness/` holds about 10 seam-bug cases, most rebuilt from real incidents as minimal patch fixtures, plus a runner (`npm run eval:harness`) that drives the review entry point headlessly in throwaway worktrees. Each case runs at least twice and is graded by deterministic checks plus a rubric judge. The output is a per-case **flip report**, not just an aggregate score. Runs are on demand only, never per-PR CI. No reviewer subagent is folded or removed without a before/after score on this set.
2. **Hard rules are hooks.** A `PreToolUse` Bash guard (`.claude/hooks/guard-bash.mjs`) denies, with a readable reason: `git add -A`/`.`/`--all`; `gh pr merge --admin` unless `RESTURA_ALLOW_ADMIN=1`; and `git push`/`gh pr create` from inside `.claude/worktrees/`. The generated-files guard also blocks `*.snap` files. Worker reports are checked by a script (`npm run verify:agent-report`) against git, red-first run included, instead of being trusted. Metrics hooks log outcomes (subagent stops, stop-check verdicts), and log names and verdicts only, never content.
3. **Progressive disclosure.** CLAUDE.md and AGENTS.md keep only invariants, a routing table and the short playbook (about 100 lines each). Detail loads on demand from `docs/agents/architecture.md` and `docs/agents/delivery.md` and from skills. The old `.claude/commands/*` became skills with descriptions that state when to use them.
4. **Review the combined result.** For multiple branches, correctness, parity and docs review run once on the `integration-check` combined diff. The security review stays per branch. A `/ship-check` READY marker bound to the head sha lets `claude-code-review.yml` skip its duplicate automatic run.
5. **Worktree lifecycle.** `npm run worktree:prune` (dry run by default) removes only clean, merged worktrees. It runs at the end of `/batch-ship` and in `/triage-maintenance`.

### Alternatives considered

- **Fold the parity and docs reviewers into main-loop skills now.** Deferred. The decision depends on the eval baseline; folding without one is the regression the guidance warns about.
- **Keep rules as prose and add more emphasis.** Rejected. The rules were already explicit and were still broken.
- **A shared `@restura/core` or an external eval service.** Out of scope. The eval runner reuses `claude -p` and local worktrees.

## Consequences

- The harness now has a measurable quality signal. Folding a reviewer means comparing the current configuration with the folded one on the same cases.
- This partly supersedes ADR 0021's "prompt/skill content, not executable gates" consequence: the delivery rules above are now executable hooks for agent sessions. CI remains the gate for humans.
- Eval runs cost model usage, so they run on demand only.
- More tooling to maintain (hooks, three scripts, fixtures). Fixtures are pinned to historical base SHAs, so they don't drift with `main`.
- `--admin` merges now need an explicit, visible override.

## References

- Code: `.claude/hooks/guard-bash.mjs`, `.claude/hooks/log-subagent.mjs`, `.claude/settings.json`, `scripts/verify-agent-report.mjs`, `scripts/worktree-prune.mjs`, `scripts/harness-eval.mjs`, `evals/harness/`, `docs/agents/`, `.claude/skills/{batch-ship,ship-check,triage-maintenance}/SKILL.md`, `.github/workflows/claude-code-review.yml`
- Related: [ADR 0021 (maintenance harness)](./0021-maintenance-harness.md), [ADR 0028 (architecture boundaries and ratchets)](./0028-typescript-architecture-boundaries.md)
