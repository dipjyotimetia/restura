# Codex agentic harness hardening

## Goal

Make a fresh Restura checkout self-describing and deterministic for Codex from
task discovery through implementation, validation, review, and release. The
harness must preserve Restura's web Worker, self-hosted Node, and Electron
parity and must not weaken the existing SSRF, IPC-validation, or `SecretRef`
security boundaries.

The deliverable is repository configuration and tested automation. Changing
the live GitHub branch-protection ruleset is intentionally deferred; the
repository will expose one stable aggregate check that can be required later.

## Baseline and confirmed gaps

The starting revision is `a4a856a153c6025895c55fb35b458cd85d2c965d`.

- Codex only receives `.codex/config.toml`. The mature Claude commands, skills,
  hooks, and reviewer agents are not discoverable through Codex's native
  `.agents/skills`, `.codex/hooks.json`, and `.codex/agents` surfaces.
- The Chrome DevTools MCP uses an unpinned `@latest` package and inherits the
  user's npm cache. In the audited environment that cache is not writable; an
  isolated cache succeeds.
- A clean `npm ci` followed by `npm run test:ci` fails before collecting tests
  because the ignored sandbox-library bundle has not been generated. The
  regular `test` and `test:run` scripts do generate it, but `test:ci` and
  `test:coverage` do not.
- After generating the bundle, all 4,139 tests pass, but coverage fails because
  5,227 branches are uncovered and the budget allows 5,226.
- `npm run validate` uses the non-coverage test command even though project
  guidance says it matches CI.
- CI runs valuable platform jobs, but the live ruleset only requires the core
  `validate` job. There is no tested repository-owned aggregate result for the
  full web, Node, Electron, extension, documentation, and packaging matrix.
- Release preflight reruns the non-coverage local validation command and can
  proceed without proving that the exact candidate commit passed the full CI
  matrix.
- `AGENTS.md`, OpenWiki testing/operations pages, and `docs/CI_CD.md` describe
  validation thresholds or live protection settings that do not match current
  behavior.
- `.claude/settings.local.json` is tracked despite being a machine-local,
  potentially sensitive file that `.gitignore` already excludes.

## Design principles

1. **Native discovery, shared policy.** Codex receives native entry points and
   does not depend on undocumented discovery of `.claude` files. Shared Restura
   invariants remain consistent across runtimes and are checked by tests.
2. **Clean checkout is the unit of correctness.** Every documented validation
   command performs its own required generation or fails with an actionable
   message.
3. **One shipping verdict.** CI publishes one stable `merge-gate` result that
   represents all required repository checks. Release automation consumes the
   same verdict for the exact candidate SHA.
4. **Hooks are bounded and testable.** Hook payload parsing, path handling,
   generated-file protection, formatting, and stop behavior have fixture tests.
   Validation loops are capped and cannot block forever.
5. **Least privilege.** Audit agents are read-only, generated-file exceptions
   remain explicit, local settings remain untracked, and no hook or skill reads
   secrets.

## Codex-native repository harness

### Skills

Create repo-scoped Codex skills under `.agents/skills/` for the established
Restura workflows:

- feature development and protocol/platform parity;
- production checks and full validation;
- browser-based UI verification;
- fix-until-green with a hard attempt cap;
- pre-shipping review and shipping handoff;
- documentation synchronization;
- maintenance triage and new-protocol scaffolding;
- harness/skill reporting where the underlying data is available.

Each skill will name its trigger conditions, required inputs, deterministic
exit gate, and security boundaries. Codex wording may differ from Claude
command wrappers, but tests will assert that the shared commands and critical
invariants remain aligned. Files will be real files rather than symlinks so
Windows checkouts and packaged source archives behave consistently.

### Reviewer agents

Add read-only Codex agents under `.codex/agents/` for:

- security-boundary review, including SSRF, redirects, header policy,
  `SecretRef`, and IPC validation;
- cross-platform parity review across web Worker, self-hosted Node, and
  Electron;
- documentation and generated-artifact consistency review.

The root Codex configuration will register the agents explicitly. Agent
instructions will require evidence with file references and will prohibit
mutation. The pre-PR skill will run these independent reviews plus a
fresh-context code review before publication.

### Hooks

Add `.codex/hooks.json` and scripts under `.codex/hooks/` using the current
Codex hook contract. Hook commands resolve the repository root with Git rather
than assuming the process working directory.

- `PreToolUse` protects generated files such as the OpenCollection types and
  capability matrix. It recognizes direct path fields and `apply_patch`
  `Add/Update/Delete File` headers. An explicit generation command is the
  supported bypass.
- `PostToolUse` formats supported edited files with the repository's pinned
  Biome binary. It handles multiple files and reports failures without exposing
  file contents.
- `PreCompact` records a bounded, ignored compaction event log for harness
  diagnosis.
- `Stop` runs a bounded validation decision. It emits the current Codex
  `continue`/`stopReason` JSON contract, stores only a hash/status cache, and
  will not re-run or re-block indefinitely for an unchanged failing tree.

Hook scripts will parse JSON from stdin, keep stdout machine-readable, write
human diagnostics to stderr when appropriate, and fail closed only for the
specific policy they enforce. Obsolete Claude-only hook matchers and response
schemas will not be copied.

### MCP configuration

Pin `chrome-devtools-mcp` to the audited version and invoke it non-interactively
with a repository-local ignored npm cache. Configure bounded startup/tool
timeouts. The browser remains an opt-in development aid; deterministic tests
and CI do not depend on it.

## Deterministic local validation

Make sandbox-library generation a prerequisite of every Vitest entry point,
including `test:coverage` and `test:ci`. This keeps the generated source
ignored while making clean-checkout commands self-contained.

Change `npm run validate` to run the coverage-enforcing test command. Keep the
existing type checks, Biome lint/format checks, OpenCollection verification,
capability-matrix verification, and CLI tests. Add a narrower documented
developer command only if fast iteration needs it; it must not be described as
the shipping gate.

Add a focused test for the currently uncovered branch instead of increasing
the uncovered-item budget. Coverage budgets remain monotonic: a change may
reduce an allowance, but must not raise it to make CI green.

Harness tests will validate:

- fresh-checkout test scripts invoke sandbox generation;
- Codex skills and agents are discoverable and contain required policy;
- hook configuration and JSON contracts are valid;
- patch payloads cannot bypass generated-file protection;
- CI aggregation and release gating retain all required jobs;
- documentation does not claim that non-coverage validation matches CI.

## CI merge gate

Add an `if: always()` `merge-gate` job to the main CI workflow. It depends on
the complete required matrix:

- core type, lint, format, codegen, capability, coverage, build, and size gates;
- documentation checks;
- web Playwright shards;
- Electron Playwright tests;
- cross-OS Electron packaging smoke;
- Chrome extension E2E;
- VS Code extension unit and integration checks.

Jobs needed for the gate must run for both pull-request commits and pushes to
`main`, because a release candidate is the merged commit, not the last PR head.
Expected conditional skips, such as explicitly unsupported Dependabot secret
jobs, will be encoded in a small tested gate evaluator. Unexpected skipped,
cancelled, or failed required jobs make `merge-gate` fail.

The aggregate job name is stable and documented as the future single required
ruleset check. This change does not mutate the live ruleset.

## Exact-SHA release authorization

Release preflight will compute the candidate SHA before any publishing job.
For manual beta/stable releases it is the selected `main` revision; for the
trusted merged release PR it is the merge commit. Before creating or promoting
a release, preflight waits for a successful `merge-gate` check run whose
`head_sha` exactly equals that candidate SHA.

The wait is bounded and distinguishes pending, missing, failed, and successful
checks. It does not accept a successful check from another commit or merely
rerun the cheaper local validator. A tested script will own the check-run
selection logic so workflow YAML is declarative and reviewable.

The existing repair path for an already-created draft release remains narrow.
It will verify the tagged SHA and either require its historical `merge-gate` or
use an explicitly documented repair-only exception; it will not silently treat
current `main` as evidence for an older tag.

## Documentation and local-state hygiene

Update `AGENTS.md` and `CLAUDE.md` together, plus the OpenWiki quickstart-linked
testing and operations pages and `docs/CI_CD.md`. They will distinguish:

- fast developer checks;
- the local coverage-aware shipping gate;
- the full CI `merge-gate` matrix;
- the release exact-SHA requirement;
- currently configured live protection from recommended follow-up protection.

Remove `.claude/settings.local.json` from Git tracking without reading or
printing it. Because the ignore rule already exists, developers may retain
their own local file without future accidental commits. No local settings or
secret values will be migrated into Codex configuration.

## Validation and acceptance criteria

Implementation is complete only when a fresh worktree passes:

1. clean dependency installation followed directly by the coverage test;
2. hook unit/contract tests and direct JSON smoke tests;
3. `codex --strict-config doctor --json` and Codex skill/agent discovery checks;
4. `npm run validate` with coverage enforcement;
5. focused workflow/release structure and exact-SHA selection tests;
6. `npm run electron:compile`;
7. browser verification for any user-visible documentation/UI surface that is
   changed;
8. a fresh diff review covering security, platform parity, docs, and generated
   artifacts.

CI-only platform jobs will be verified structurally and then through the branch
CI run before shipping. No result may be reported as passing if it was skipped,
stale, or run against a different SHA.

## Non-goals and deferred actions

- Do not change the live GitHub ruleset in this work. After merge, the
  repository owner can require the stable `merge-gate` check and enable the
  documented review protections as a separate administrative action.
- Do not redesign product runtime protocols or relax SSRF, IPC, secret, auth,
  signing, or release-provenance controls.
- Do not make Claude depend on Codex-specific runtime behavior. Cross-runtime
  parity is enforced at the shared-policy and deterministic-command level.
- Do not restore the historical Codex harness verbatim; its relative paths,
  hook matchers, and stop-response schema are obsolete.
