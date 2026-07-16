# ADR 0021: Maintenance harness — Claude Code tooling for production-grade upkeep

**Status:** Accepted, 2026-06-10

**Expanded by:** [ADR 0028 (Codex agentic harness and shipping gates)](./0028-codex-agentic-harness-and-shipping-gates.md)

## Context

Restura ships one React renderer to three backends (Cloudflare Worker, Node/Docker, Electron) with a security-critical protocol core, six independent TypeScript projects, two codegen drift gates, a capability matrix, a large documentation surface, and a desktop-only feature set. Keeping all of that consistent is the bulk of the maintenance cost, and several gaps were only known as folklore:

1. **`npm run type-check` only type-checks the renderer.** The root `tsconfig.json` runs bare `tsc --noEmit` and excludes `worker`, `electron/main`, and `cli`. CI ran six separate `tsc` invocations, but there was no single local command equivalent — so a green local `validate` did not mean the Electron main process, Worker, or CLI compiled. The pre-commit hook skips `tsc` entirely, so type errors landed in commits.
2. **No content-parity gate for docs.** `npm run docs:check` is only `astro check` (links/types). `CLAUDE.md` and `docs/ARCHITECTURE.md` had both drifted from the actual type-check behavior; the `adrs.mdx` timeline is hand-maintained.
3. **The existing `restura-feature-dev` skill covers adding features, not verifying or maintaining them**, and the built-in `/code-review` / `/security-review` lack Restura-specific knowledge (the single-source SSRF guard, the ADR-0006 DNS-rebind residual window, broker-discovery bypass, the IPC validate+rate-limit+sender triad, SecretRef isolation).

We wanted the assistant (Claude Code) to be able to build and maintain Restura at production grade, following the published guidance in _"Lessons from building Claude Code: how we use skills"_ — skills encode gotchas and organizational knowledge (not the obvious), use progressive disclosure, prefer scripts for deterministic work, write descriptions as trigger conditions, and accrete over time.

## Decision

Add a **maintenance harness** under `.claude/`, paired with a source-level fix for the type-check gap.

**Source fix (closes the root cause).** Add `npm run type-check:all`, which aggregates every TypeScript project CI used at the time, and chain it into `npm run validate`. The command has since expanded as more workspaces were added. Correct the stale type-check claims in `CLAUDE.md` and `docs/ARCHITECTURE.md`.

**Skill — `restura-production-checks`.** The verify/maintain counterpart to `restura-feature-dev`. `SKILL.md` carries the top gotchas (type-check gap, pre-commit skips tsc, codegen drift gates, capability parity, coverage thresholds, commit scope-enum); `references/` provides progressive disclosure (`verification-gates.md`, `security-checklist.md`, `release-readiness.md`, `docs-parity.md`).

**Subagents.** `restura-security-auditor` (SSRF single-source, DNS-rebind residual window, broker-discovery bypass, IPC guard triad, SecretRef isolation, wire-level signing), `restura-parity-checker` (web/desktop wiring + capability matrix), `restura-docs-steward` (doc-ownership map + "does this need an ADR?" rubric). Each earns its place by encoding knowledge the built-in reviewers lack.

**Commands.** `/ship-check` (run the full gate `validate` skips, triage failures to `file:line`, dispatch the review subagents), `/new-protocol` (drives the `restura-feature-dev` runbook), `/docs-sync` (walk the doc-ownership map and update every stale surface).

**Measurement hook.** A `PreToolUse` hook (matcher `Skill`) appends skill invocations to `.claude/metrics/skill-usage.log` (gitignored) so under/over-triggering is observable, per the blog's measurement lesson. Shipped via committed `.claude/settings.json` (not the gitignored `settings.local.json`).

## Consequences

**Positive**

- Local `validate` is now type-complete; the most common "passed locally, failed CI" class is closed at the source.
- The verify/maintain knowledge that was folklore is now discoverable and triggers itself.
- Reviews of the security and wiring surfaces carry Restura-specific invariants instead of generic advice.
- Docs have a parity gate (the steward + ownership map) where CI has none.

**Negative**

- `type-check:all` makes `validate` slower locally (six `tsc` runs); the renderer-only `type-check` remains for fast inner-loop checks.
- The harness is prompt/skill content, not executable gates — it guides the assistant but does not block a human running raw `git`/`npm`. The hard gates remain CI.
- More artifacts to keep current; this ADR and the doc-ownership map are themselves maintenance surface.

## References

- Code: `package.json` (`type-check:all`, `validate`), `.claude/skills/restura-production-checks/`, `.claude/agents/restura-{security-auditor,parity-checker,docs-steward}.md`, `.claude/commands/{ship-check,new-protocol,docs-sync}.md`, `.claude/hooks/log-skill-usage.mjs`, `.claude/settings.json`
- Companion: `.claude/skills/restura-feature-dev/` (the build-side skill)
- Related: [ADR 0004 (security hardening)](./0004-security-hardening.md), [ADR 0006 (connection + DNS hardening)](./0006-electron-connection-and-dns-hardening.md), [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md), [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md), [ADR 0016 (wire-level auth signing)](./0016-wire-level-auth-signing.md), [ADR 0028 (Codex agentic harness and shipping gates)](./0028-codex-agentic-harness-and-shipping-gates.md)
