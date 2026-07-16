# ADR 0028: Codex agentic harness and shipping gates

**Status:** Accepted, 2026-07-16

## Context

ADR 0021 introduced a Claude Code maintenance harness and made local type
checking complete, but it did not give Codex an equivalent discoverable
lifecycle. Three additional enforcement gaps remained:

1. The nominal local shipping command ran Vitest without coverage, while the
   coverage command could depend on ignored generated sandbox libraries. A
   clean checkout therefore did not exercise the same coverage policy.
2. CI exposed many independent platform jobs without one deterministic verdict.
   A narrow required check could be green while docs, Electron, extension, or
   packaging validation was missing, skipped, or failed.
3. Stable release automation trusted locally repeated validation instead of a
   completed CI verdict attached to the exact commit being published. The live
   branch ruleset was also narrower than the documented recommendation, but
   changing repository administration is an external mutation.

Restura needs agent guidance, local validation, CI, and release automation to
form one progressively stronger chain rather than four unrelated conventions.

## Decision

### Codex-native discovery and lifecycle

Publish shared workflows under `.agents/skills/`, read-only Restura reviewers
under `.codex/agents/`, and bounded lifecycle hooks through
`.codex/hooks.json`. Pin the Chrome DevTools MCP launcher, keep its npm cache
repository-local and ignored, and document runtime inspection in
`.codex/README.md`. Hook state is worktree-aware and stored under Git metadata;
machine-local settings and diagnostics are never tracked.

Generated-source edits are blocked before mutation, edited files are formatted
with Biome, compaction records a bounded handoff, and the stop hook runs the
deterministic local gate with an unchanged-state deduplication guard. These are
repository policies, not substitutes for human authorization or CI.

### Coverage-aware clean-checkout validation

Both `test:coverage` and `test:ci` first generate the ignored QuickJS sandbox
libraries and then run Vitest with coverage. `npm run validate` uses `test:ci`.
Global coverage is an uncovered-item budget, so any net-new untested production
surface fails the gate, while `shared/protocol/**` retains stronger percentage
thresholds.

### One complete CI verdict

Add a `merge-gate` job that evaluates every required validation and shipping
surface: core validation, documentation, browser and Electron E2E, browser and
VS Code extension E2E, and cross-OS Electron packaging. Missing, pending,
failed, cancelled, timed-out, or unapproved skipped jobs fail closed. Only the
explicit native-job skip set for Dependabot pull requests is allowed.

Required platform jobs also run on pushes to `main`, so a release candidate
created by the release-bot bypass receives the same complete verdict.

### Exact-commit release proof

Release preflight resolves one immutable candidate SHA and polls GitHub Checks
for a successful `merge-gate` attached to that exact SHA. Missing, pending, or
failed evidence prevents every publish job. Stable preparation, recovery, and
tag-repair paths all use the same proof boundary.

The repository records the currently observed live rules and recommends
requiring `merge-gate`, but does not mutate GitHub administration. That remains
a deferred maintainer action after the check context exists on the default
branch.

## Consequences

**Positive**

- Claude Code and Codex now expose equivalent Restura-specific build, review,
  validation, and shipping knowledge.
- A clean checkout can reproduce the coverage-aware local gate.
- One status context represents the complete cross-platform CI verdict.
- Releases fail closed unless the exact candidate commit has full CI evidence.
- Documentation distinguishes committed enforcement from live administrative
  state instead of presenting recommendations as facts.

**Negative**

- `npm run validate` is slower because coverage instrumentation is always part
  of the local shipping gate.
- Pushes to `main` consume more CI because platform jobs must produce release
  evidence.
- Hook and skill surfaces add maintenance cost and must evolve with the repo.
- The branch ruleset remains narrower until a maintainer performs the deferred
  administrative update.

## References

- Runtime: `.codex/config.toml`, `.codex/hooks.json`, `.codex/README.md`,
  `.agents/skills/`, `.codex/agents/`
- Local gates: `package.json`, `vitest.config.ts`
- CI and release: `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
  `scripts/ci/assert-merge-gate.mjs`, `scripts/ci/wait-for-check-run.mjs`
- Tests: `tests/agentic-harness-config.test.ts`, `tests/codex-hooks.test.ts`,
  `tests/ci-merge-gate.test.ts`, `tests/wait-for-check-run.test.ts`
- Expands: [ADR 0021 (maintenance harness)](./0021-maintenance-harness.md)
