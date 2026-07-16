# Restura Codex harness

This directory is the Codex-specific half of Restura's shared agentic
engineering harness. Start with the root `AGENTS.md` and OpenWiki quickstart;
use this page for runtime wiring and lifecycle diagnostics.

## Discovery surfaces

- `.agents/skills/` contains the reusable build, verification, review, docs,
  maintenance, and shipping workflows that Codex discovers for this repo.
- `.codex/agents/` contains read-only Restura security, platform-parity, and
  documentation reviewers. They report findings; the primary agent owns edits.
- `.codex/config.toml` bounds parallelism and starts the Chrome DevTools MCP
  through the pinned launcher; Codex discovers reviewer definitions from
  `.codex/agents/`.
- `.codex/hooks.json` defines repository lifecycle hooks. Inspect them with
  Codex `/hooks`; inspect the registered Chrome DevTools server with `/mcp`.

## Hooks and state

The committed hooks are deterministic repository policy, not a secret-bearing
personal configuration:

- generated-file edits through the Codex edit tools are rejected with source
  and regeneration guidance;
- edited paths are recorded under the worktree-local ignored `.codex/metrics/`
  directory for bounded
  diagnostics, without executing mutable workspace tools;
- pre-compaction events are recorded under ignored `.codex/metrics/` state;
- an explicit `npm run validate` records content-bound validation evidence in
  that worktree-local directory, and the stop hook only accepts matching successful
  evidence. It never launches repository package scripts automatically.

Machine-local `.claude/settings.local.json`, MCP npm cache data under
`.codex/cache/`, and metrics under `.codex/metrics/` remain ignored and must not
be committed. The MCP launcher pins `chrome-devtools-mcp@1.6.0` and resolves its
npm cache from the repository root, so worktree startup is reproducible.

## Validation and shipping

Use the narrowest useful check while iterating, then run `npm run validate` as
the coverage-aware local shipping gate. It type-checks every TypeScript project,
runs Biome and generated-file drift checks, enforces capability parity, executes
Vitest with coverage budgets, and tests the CLI.

Local validation is not the complete cross-platform verdict. GitHub's
`merge-gate` aggregates validation, the shipped self-hosted image plus API/SPA
smoke, docs, browser and Electron E2E, browser and VS Code extensions, and cross-OS
Electron packaging. Release preflight accepts only the trusted CI workflow's
check on the exact candidate commit before publishing.

Live branch rules are administrative state. The repository documents their
observed state and recommended update in `docs/CI_CD.md`; agents must not mutate
them without explicit authorization.

## Diagnostics

Run `codex --strict-config doctor --json` to validate the effective Codex setup.
If a hook blocks completion, inspect its bounded diagnostic path rather than
bypassing it. If MCP startup fails, run the launcher directly with `--version`
to separate npm/cache issues from Chrome connection issues.
