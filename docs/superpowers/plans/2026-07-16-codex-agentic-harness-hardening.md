# Codex Agentic Harness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a fresh Restura checkout a complete Codex-native development,
validation, review, CI, and exact-SHA release harness.

**Architecture:** Codex-native skills, read-only custom agents, lifecycle hooks,
and a pinned browser MCP sit beside the existing Claude harness while sharing
the same Restura invariants. Local `validate` becomes coverage-aware; CI emits a
tested aggregate `merge-gate`; release preflight waits for that check on the
exact candidate SHA.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Biome, Codex `hooks.json` and
custom-agent TOML, GitHub Actions, GitHub Check Runs REST API.

## Global Constraints

- Work only on `agent/codex-harness-hardening` in
  `.worktrees/codex-harness-hardening`; never implement on `main`.
- Keep the live GitHub ruleset unchanged. Document the post-merge
  administrative follow-up only.
- Preserve web Worker, self-hosted Node, and Electron parity.
- Do not weaken SSRF/redirect/header policy, IPC validation, `SecretRef`,
  signing, provenance, or release authorization boundaries.
- Do not read or print `.claude/settings.local.json`; remove it from tracking
  while leaving the existing ignore rule.
- Use Biome, not Prettier.
- No production behavior/configuration change without first observing its
  focused regression test fail, except pure documentation and generated files.
- Coverage budgets may stay equal or decrease; never raise an uncovered-item
  allowance to make CI pass.
- Hook commands must resolve the Git root, support linked worktrees, keep stdout
  machine-readable, and use current Codex hook response contracts.
- Codex skills are real files under `.agents/skills`; do not use symlinks.

---

### Task 1: Make fresh-checkout validation deterministic and restore coverage

**Files:**
- Modify: `package.json`
- Modify: `src/lib/shared/__tests__/release-notes.test.ts`
- Create: `tests/agentic-harness-config.test.ts`

**Interfaces:**
- Produces: `npm run test:ci` and `npm run test:coverage` that generate the
  ignored sandbox bundle before Vitest.
- Produces: `npm run validate` as the coverage-aware local shipping gate.

- [ ] **Step 1: Add failing script-contract tests**

Create `tests/agentic-harness-config.test.ts` with these initial assertions:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
) as { scripts: Record<string, string> };

describe('agentic harness package scripts', () => {
  it.each(['test:coverage', 'test:ci'])('%s generates sandbox libraries first', (name) => {
    expect(packageJson.scripts[name]).toMatch(
      /^node scripts\/ensure-sandbox-libs\.mjs && vitest run --coverage/
    );
  });

  it('makes validate coverage-aware', () => {
    expect(packageJson.scripts.validate).toContain('npm run test:ci');
    expect(packageJson.scripts.validate).not.toContain('npm run test:run');
  });
});
```

- [ ] **Step 2: Verify the script-contract test is red**

Run:

```bash
npx vitest run tests/agentic-harness-config.test.ts
```

Expected: three failed assertions showing `test:coverage`/`test:ci` omit the
generator and `validate` still calls `test:run`.

- [ ] **Step 3: Fix the package scripts minimally**

Change only these script values:

```json
"test:coverage": "node scripts/ensure-sandbox-libs.mjs && vitest run --coverage",
"test:ci": "node scripts/ensure-sandbox-libs.mjs && vitest run --coverage",
"validate": "npm run type-check:all && npm run lint && npm run format:check && npm run verify:opencollection-types && npm run capabilities:check && npm run test:ci && npm run --workspace cli test"
```

- [ ] **Step 4: Verify the script-contract test is green**

Run `npx vitest run tests/agentic-harness-config.test.ts`.

Expected: all tests pass.

- [ ] **Step 5: Add a focused coverage regression test**

Add this case to the `parseReleaseNoteContent` suite. The mismatched backtick
fence covers the untested false branch at `release-notes.ts:115` while asserting
the parser remains fence-aware:

```ts
it('keeps headings hidden until a fenced block closes with the matching marker', () => {
  expect(
    parseReleaseNoteContent(`## Fixed

~~~md
## Hidden heading
\`\`\`
## Still hidden
~~~

## Added

- Visible item.`)
  ).toEqual({
    highlights: null,
    upgradeNotes: null,
    sections: [
      {
        title: 'Added',
        body: '- Visible item.',
        itemCount: 1,
      },
      {
        title: 'Fixed',
        body: '~~~md\n## Hidden heading\n```\n## Still hidden\n~~~',
        itemCount: 0,
      },
    ],
    contributors: null,
    extraSections: [],
    preamble: null,
    fallbackBody: null,
  });
});
```

- [ ] **Step 6: Prove coverage is restored without increasing budgets**

Run:

```bash
npx vitest run src/lib/shared/__tests__/release-notes.test.ts
npm run test:ci
git diff --exit-code vitest.config.ts
```

Expected: the focused suite passes; all root tests pass; uncovered branches are
at most 5,226; `vitest.config.ts` is unchanged.

- [ ] **Step 7: Commit the deterministic validation change**

```bash
git add package.json src/lib/shared/__tests__/release-notes.test.ts tests/agentic-harness-config.test.ts
git commit -m "fix(tests): make clean checkout validation coverage aware"
```

---

### Task 2: Add Codex-native skills, read-only reviewers, and bounded MCP config

**Files:**
- Create: `.agents/skills/{restura-feature-dev,restura-production-checks,verify-ui-change,fix-until-green,ship-check,docs-sync,new-protocol,babysit-prs,triage-maintenance,skill-report}/SKILL.md`
- Create: `.agents/skills/restura-feature-dev/references/*.md`
- Create: `.agents/skills/restura-production-checks/references/*.md`
- Create: `.codex/agents/restura-security-auditor.toml`
- Create: `.codex/agents/restura-parity-checker.toml`
- Create: `.codex/agents/restura-docs-steward.toml`
- Create: `.codex/run-chrome-devtools-mcp.mjs`
- Modify: `.codex/config.toml`
- Extend test: `tests/agentic-harness-config.test.ts`

**Interfaces:**
- Produces: repo skills auto-discovered from `.agents/skills/*/SKILL.md`.
- Produces: custom agents auto-discovered from `.codex/agents/*.toml`.
- Produces: `chrome-devtools` MCP pinned to `1.6.0`, using a Git-root-resolved
  `.codex/cache/npm`, with 30-second startup and 120-second tool timeouts.

- [ ] **Step 1: Add failing discovery and invariant tests**

Extend `tests/agentic-harness-config.test.ts` with filesystem helpers and these
required names:

```ts
const requiredSkills = [
  'restura-feature-dev',
  'restura-production-checks',
  'verify-ui-change',
  'fix-until-green',
  'ship-check',
  'docs-sync',
  'new-protocol',
  'babysit-prs',
  'triage-maintenance',
  'skill-report',
];
const requiredAgents = [
  'restura-security-auditor',
  'restura-parity-checker',
  'restura-docs-steward',
];

it.each(requiredSkills)('publishes the %s Codex skill', (name) => {
  const text = readFileSync(resolve(process.cwd(), `.agents/skills/${name}/SKILL.md`), 'utf8');
  expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`, 'm'));
  expect(text).toMatch(/^description: .+/m);
});

it.each(requiredAgents)('publishes the %s read-only Codex agent', (name) => {
  const text = readFileSync(resolve(process.cwd(), `.codex/agents/${name}.toml`), 'utf8');
  expect(text).toContain(`name = "${name}"`);
  expect(text).toContain('sandbox_mode = "read-only"');
  expect(text).toContain('developer_instructions = """');
});

it('pins Chrome DevTools MCP with an isolated cache and bounded timeouts', () => {
  const text = readFileSync(resolve(process.cwd(), '.codex/config.toml'), 'utf8');
  const launcher = readFileSync(
    resolve(process.cwd(), '.codex/run-chrome-devtools-mcp.mjs'),
    'utf8'
  );
  expect(text).toContain('command = "node"');
  expect(text).toContain('args = [".codex/run-chrome-devtools-mcp.mjs"]');
  expect(launcher).toContain("chrome-devtools-mcp@1.6.0");
  expect(launcher).toContain("'.codex', 'cache', 'npm'");
  expect(text).toContain('startup_timeout_sec = 30');
  expect(text).toContain('tool_timeout_sec = 120');
  expect(`${text}\n${launcher}`).not.toContain('@latest');
});
```

Add invariant assertions that the production-check and ship-check skills name
`npm run validate`, coverage, all three shipping targets, security/parity/docs
review, and the no-ruleset-mutation boundary.

- [ ] **Step 2: Verify discovery tests are red**

Run `npx vitest run tests/agentic-harness-config.test.ts`.

Expected: missing `.agents/skills`, `.codex/agents`, and unpinned MCP failures.

- [ ] **Step 3: Port the three existing skills as native Codex skills**

Create real-file Codex copies of the current content and references from:

```text
.claude/skills/restura-feature-dev/**
.claude/skills/restura-production-checks/**
.claude/skills/verify-ui-change/**
```

Keep their `name` values unchanged. Update stale statements so `validate` is
coverage-aware and represents the local shipping gate, while `merge-gate`
represents the complete CI matrix. Replace Claude-only “dispatch” wording with
Codex custom-agent names without changing SSRF, IPC, `SecretRef`, or platform
parity rules.

- [ ] **Step 4: Convert the seven command workflows into Codex skills**

Create the seven command-derived entry points with these exact frontmatter
values:

| Path | `name` | `description` |
| --- | --- | --- |
| `.agents/skills/babysit-prs/SKILL.md` | `babysit-prs` | `Monitor Restura pull requests, diagnose real CI logs, address scoped review feedback, and continue until every watched PR is merged or closed.` |
| `.agents/skills/docs-sync/SKILL.md` | `docs-sync` | `Update every Restura documentation surface made stale by a code or workflow change, using the repository documentation ownership map.` |
| `.agents/skills/fix-until-green/SKILL.md` | `fix-until-green` | `Iterate on a Restura branch until a deterministic validation gate passes, with a hard attempt cap and root-cause-first fixes.` |
| `.agents/skills/new-protocol/SKILL.md` | `new-protocol` | `Scaffold a new Restura protocol across shared core, Worker and self-host, Electron IPC, renderer, capability matrix, tests, and docs.` |
| `.agents/skills/ship-check/SKILL.md` | `ship-check` | `Run Restura pre-shipping validation, builds, platform reviews, documentation review, and applicable end-to-end tests before publication.` |
| `.agents/skills/skill-report/SKILL.md` | `skill-report` | `Analyze local Restura agent-skill usage data without exposing session identifiers and recommend trigger-description improvements.` |
| `.agents/skills/triage-maintenance/SKILL.md` | `triage-maintenance` | `Triage Restura dependency, security, CI, and agent-harness maintenance using evidence from the repository and GitHub.` |

Each file starts with `---`, then the exact `name` and `description` above,
then a closing `---`.

Port the operational body and replace `$ARGUMENTS` with “the scope supplied by
the user.” Preserve these hard constraints:

```text
fix-until-green: default cap 5; repeated identical failure stops the loop
ship-check: coverage-aware validate; security/parity/docs/fresh review fan-out
docs-sync: production-check docs ownership map is authoritative
new-protocol: shared core + Worker/Node + Electron + renderer + capability matrix
babysit-prs: inspect real logs before edits; never force-push without approval
triage-maintenance: security-boundary changes require specialized review
skill-report: report-only by default and never expose session identifiers
```

- [ ] **Step 5: Create three read-only custom-agent TOML files**

Use this schema for each file, with the corresponding existing Claude agent
body adapted into `developer_instructions`:

```toml
name = "restura-security-auditor"
description = "Review Restura security boundaries and report evidence-backed findings."
nickname_candidates = ["Security Auditor"]
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
Review only; do not modify files. Inspect the full diff and touched files.
Enforce the single-source SSRF guard, IPC validation plus rate limiting plus
trusted-sender checks, SecretRef isolation, wire-level signing, header policy,
and sandbox boundaries. Report severity-ranked findings with file:line evidence,
tests to run, and verified-clean invariants.
"""
```

Create analogous parity and docs agents using the full checklists in
`.claude/agents/restura-parity-checker.md` and
`.claude/agents/restura-docs-steward.md`. All three must retain
`sandbox_mode = "read-only"` and evidence requirements.

- [ ] **Step 6: Pin and bound the MCP and agent runtime**

Create `.codex/run-chrome-devtools-mcp.mjs`. It resolves the root with
`git rev-parse --show-toplevel`, starts platform-appropriate `npx` with
`--yes chrome-devtools-mcp@1.6.0` plus forwarded CLI arguments, sets
`NPM_CONFIG_CACHE` to `<root>/.codex/cache/npm`, inherits stdio, forwards
`SIGINT`/`SIGTERM`, and exits with the child status. This prevents Codex sessions
started in a subdirectory from creating an unignored nested cache.

Replace `.codex/config.toml` with:

```toml
[agents]
max_threads = 4
max_depth = 1

[mcp_servers.chrome-devtools]
command = "node"
args = [".codex/run-chrome-devtools-mcp.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

- [ ] **Step 7: Verify discovery, config parsing, and MCP startup**

Run:

```bash
npx vitest run tests/agentic-harness-config.test.ts
codex --strict-config doctor --json
node .codex/run-chrome-devtools-mcp.mjs --version
```

Expected: tests pass; doctor has no project-config startup warning; MCP reports
`1.6.0` without using the user npm cache.

- [ ] **Step 8: Commit Codex skills, agents, and MCP config**

```bash
git add .agents .codex/agents .codex/config.toml .codex/run-chrome-devtools-mcp.mjs tests/agentic-harness-config.test.ts
git commit -m "feat(ci): add Codex-native development harness"
```

---

### Task 3: Implement current-contract Codex lifecycle hooks

**Files:**
- Create: `.codex/hooks.json`
- Create: `.codex/hooks/_shared.mjs`
- Create: `.codex/hooks/guard-generated-files.mjs`
- Create: `.codex/hooks/format-edit.mjs`
- Create: `.codex/hooks/log-compaction.mjs`
- Create: `.codex/hooks/stop-policy.mjs`
- Create: `.codex/hooks/stop-checks.mjs`
- Create: `tests/codex-hooks.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- `_shared.mjs` exports `readPayload`, `repoRoot`, `extractToolPaths`,
  `projectRelative`, `gitPath`, and `treeSignature`.
- Generated-file guard exits `2` with a non-empty stderr reason only when an
  edit targets a generated file; otherwise exits `0` silently.
- Stop hook emits either nothing or
  `{"continue":false,"stopReason":"Restura validation is not green. Fix the reported npm run validate failure before stopping."}`
  and deduplicates unchanged failures.

- [ ] **Step 1: Write failing hook-contract tests**

Create `tests/codex-hooks.test.ts`. Use `spawnSync(process.execPath,
[script], { input: JSON.stringify(payload), encoding: 'utf8', cwd: repoRoot })`
and assert:

```ts
it('blocks a generated file named directly', () => {
  const result = runHook('guard-generated-files.mjs', {
    cwd: repoRoot,
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { file_path: `${repoRoot}/docs/CAPABILITY_MATRIX.md` },
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('src/lib/shared/capabilities.ts');
  expect(result.stdout).toBe('');
});

it('blocks every generated path embedded in apply_patch input', () => {
  const result = runHook('guard-generated-files.mjs', {
    cwd: repoRoot,
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      patch: '*** Begin Patch\n*** Update File: src/lib/opencollection/spec-types.ts\n@@\n-x\n+y\n*** End Patch',
    },
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('gen:opencollection-types');
});

it('allows ordinary source edits', () => {
  const result = runHook('guard-generated-files.mjs', {
    cwd: repoRoot,
    tool_name: 'apply_patch',
    tool_input: { file_path: `${repoRoot}/src/lib/shared/release-notes.ts` },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
```

Also assert `hooks.json` uses `Edit|Write` matchers, Git-root-resolved commands,
bounded timeouts, and no obsolete `Skill` matcher or Claude
`{"decision":"block"}` stop contract.

Import `validationDecision` from `.codex/hooks/stop-policy.mjs` and assert:

```ts
expect(validationDecision({ dirty: false, signature: 'a', previous: null, passed: false })).toBeNull();
expect(validationDecision({ dirty: true, signature: 'a', previous: null, passed: true })).toBeNull();
expect(validationDecision({ dirty: true, signature: 'a', previous: null, passed: false })).toEqual({
  continue: false,
  stopReason: 'Restura validation is not green. Fix the reported npm run validate failure before stopping.',
});
expect(validationDecision({
  dirty: true,
  signature: 'a',
  previous: { signature: 'a', passed: false },
  passed: false,
})).toBeNull();
```

- [ ] **Step 2: Verify hook tests are red**

Run `npx vitest run tests/codex-hooks.test.ts`.

Expected: missing hook files.

- [ ] **Step 3: Implement shared payload/path helpers and generated guard**

`extractToolPaths` must collect `file_path`, `path`, `target`, arrays of those
fields, and every `*** Add File:`, `*** Update File:`, or `*** Delete File:`
header from string values in `tool_input`. Normalize only paths inside the Git
root. `gitPath(name)` must use `git rev-parse --git-path ${name}` so linked
worktrees do not assume `.git` is a directory.

The guard map is:

```js
const generated = new Map([
  ['src/lib/opencollection/spec-types.ts', 'Edit vendor/opencollection/v1.0.0/schema.json, then run `npm run gen:opencollection-types`.'],
  ['docs/CAPABILITY_MATRIX.md', 'Edit src/lib/shared/capabilities.ts, then run `npm run capabilities:matrix`.'],
]);
```

Any `*.generated.ts` path uses the generic regeneration message. On an internal
parser error the guard exits `0`; policy matches exit `2` with non-empty stderr.

- [ ] **Step 4: Implement format, compaction, and stop hooks**

`format-edit.mjs` runs the local `node_modules/.bin/biome format --write
--no-errors-on-unmatched` once with all existing in-repo edited paths and exits
`0` even when dependencies are absent. `log-compaction.mjs` appends one bounded
JSON line containing timestamp, trigger, and session id to
`.codex/metrics/compaction.log` and never reads the transcript.

`stop-checks.mjs` computes a signature from committed plus working-tree paths
and mtimes, stores its last status under the worktree-aware Git path
`codex-hooks/stop-checks.json`, and runs `npm run validate` with a 600-second
child-process timeout. On failure it writes exactly:

```json
{"continue":false,"stopReason":"Restura validation is not green. Fix the reported npm run validate failure before stopping."}
```

It emits nothing for a clean tree, a passing validation, or the same unchanged
failure signature already reported. Captured validation output is capped and
sent to stderr, never embedded unbounded in JSON.

Put the pure decision in `stop-policy.mjs` as:

```js
export function validationDecision({ dirty, signature, previous, passed }) {
  if (!dirty || passed || (previous?.signature === signature && previous.passed === false)) {
    return null;
  }
  return {
    continue: false,
    stopReason:
      'Restura validation is not green. Fix the reported npm run validate failure before stopping.',
  };
}
```

- [ ] **Step 5: Wire current Codex hook configuration**

Create `.codex/hooks.json` with Git-root-resolved commands:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node \"$(git rev-parse --show-toplevel)/.codex/hooks/guard-generated-files.mjs\"",
        "timeout": 10,
        "statusMessage": "Protecting generated files"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node \"$(git rev-parse --show-toplevel)/.codex/hooks/format-edit.mjs\"",
        "timeout": 30,
        "statusMessage": "Formatting edited files"
      }]
    }],
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "node \"$(git rev-parse --show-toplevel)/.codex/hooks/log-compaction.mjs\"",
        "timeout": 10
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"$(git rev-parse --show-toplevel)/.codex/hooks/stop-checks.mjs\"",
        "timeout": 610,
        "statusMessage": "Running Restura validation"
      }]
    }]
  }
}
```

- [ ] **Step 6: Ignore Codex runtime state**

Add exactly these entries near the Claude runtime ignores:

```gitignore
# Codex transient hook/MCP runtime state
.codex/metrics/
.codex/cache/
```

- [ ] **Step 7: Verify hook behavior and syntax**

Run:

```bash
npx vitest run tests/codex-hooks.test.ts
node --check .codex/hooks/*.mjs
node -e "JSON.parse(require('node:fs').readFileSync('.codex/hooks.json','utf8'))"
codex --strict-config doctor --json
```

Expected: all pass and doctor reports no project hook/config parse warning.

- [ ] **Step 8: Commit lifecycle hooks**

```bash
git add .codex/hooks.json .codex/hooks .gitignore tests/codex-hooks.test.ts
git commit -m "feat(ci): enforce Codex lifecycle validation"
```

---

### Task 4: Add a tested CI merge-gate evaluator

**Files:**
- Create: `scripts/ci/assert-merge-gate.mjs`
- Create: `tests/ci-merge-gate.test.ts`

**Interfaces:**
- Exports: `evaluateMergeGate(needs, allowedSkipped): { ok: boolean; errors: string[] }`.
- CLI consumes `NEEDS_JSON` and comma-separated `ALLOWED_SKIPPED_JOBS`.

- [ ] **Step 1: Write failing evaluator tests**

Create table-driven tests for these cases:

```ts
const successNeeds = Object.fromEntries(
  ['validate', 'electron-smoke', 'e2e', 'e2e-extension', 'e2e-electron', 'vscode-extension-e2e', 'docs']
    .map((name) => [name, { result: 'success' }])
);

expect(evaluateMergeGate(successNeeds, new Set())).toEqual({ ok: true, errors: [] });
expect(evaluateMergeGate({ ...successNeeds, e2e: { result: 'failure' } }, new Set()).ok).toBe(false);
expect(evaluateMergeGate({ ...successNeeds, docs: { result: 'cancelled' } }, new Set()).ok).toBe(false);
expect(
  evaluateMergeGate(
    { ...successNeeds, 'electron-smoke': { result: 'skipped' } },
    new Set(['electron-smoke'])
  ).ok
).toBe(true);
expect(evaluateMergeGate({ validate: { result: 'success' } }, new Set()).ok).toBe(false);
```

- [ ] **Step 2: Verify evaluator tests are red**

Run `npx vitest run tests/ci-merge-gate.test.ts`.

Expected: import failure because the evaluator does not exist.

- [ ] **Step 3: Implement the minimal evaluator and CLI**

Use the exact required job list from the test. Missing jobs, failures,
cancelled jobs, and unapproved skips add deterministic `<job>: <result>` error
strings. When executed directly, parse environment variables, print each error
to stderr, and exit `1`; otherwise print `merge-gate: all required jobs passed`
and exit `0`.

- [ ] **Step 4: Verify evaluator unit and CLI behavior**

Run:

```bash
npx vitest run tests/ci-merge-gate.test.ts
NEEDS_JSON='{"validate":{"result":"success"}}' node scripts/ci/assert-merge-gate.mjs
```

Expected: unit tests pass; the incomplete CLI fixture exits `1` and names each
missing job.

- [ ] **Step 5: Commit the evaluator**

```bash
git add scripts/ci/assert-merge-gate.mjs tests/ci-merge-gate.test.ts
git commit -m "feat(ci): add deterministic merge gate evaluator"
```

---

### Task 5: Add a tested exact-SHA Check Runs waiter

**Files:**
- Create: `scripts/ci/wait-for-check-run.mjs`
- Create: `tests/wait-for-check-run.test.ts`

**Interfaces:**
- Exports: `selectCheckRun(checkRuns, sha, name)` returning
  `{ state: 'success' | 'pending' | 'failure' | 'missing'; message: string }`.
- Exports: `waitForCheckRun(options)` with injected `fetchImpl`, `sleep`, and
  `now` for deterministic tests.
- CLI flags: `--repo owner/name --sha <40hex> --name merge-gate
  --timeout-seconds 2400 --poll-seconds 15` and token from `GITHUB_TOKEN`.

- [ ] **Step 1: Write failing exact-SHA selection tests**

Cover:

```ts
selectCheckRun([], sha, 'merge-gate').state === 'missing'
selectCheckRun([{ name: 'merge-gate', head_sha: otherSha, status: 'completed', conclusion: 'success' }], sha, 'merge-gate').state === 'missing'
selectCheckRun([{ name: 'merge-gate', head_sha: sha, status: 'in_progress', conclusion: null }], sha, 'merge-gate').state === 'pending'
selectCheckRun([{ name: 'merge-gate', head_sha: sha, status: 'completed', conclusion: 'failure' }], sha, 'merge-gate').state === 'failure'
selectCheckRun([{ name: 'merge-gate', head_sha: sha, status: 'completed', conclusion: 'success' }], sha, 'merge-gate').state === 'success'
```

Add a waiter test whose mocked fetch returns missing, pending, then success and
asserts that only the exact SHA is accepted. Add a timeout test using injected
`now` values.

- [ ] **Step 2: Verify waiter tests are red**

Run `npx vitest run tests/wait-for-check-run.test.ts`.

Expected: import failure because the waiter does not exist.

- [ ] **Step 3: Implement selection, polling, and CLI validation**

Call:

```text
GET https://api.github.com/repos/{owner}/{repo}/commits/{sha}/check-runs?check_name={name}&filter=latest&per_page=100
```

Send `Accept: application/vnd.github+json`, API version
`2022-11-28`, and bearer authentication. Reject malformed repo names, non-40-hex
SHAs, non-positive intervals, missing tokens, non-2xx responses, failed/cancelled
conclusions, and timeout. Print only status summaries; never print the token or
response headers.

- [ ] **Step 4: Verify waiter tests and CLI argument rejection**

Run:

```bash
npx vitest run tests/wait-for-check-run.test.ts
node scripts/ci/wait-for-check-run.mjs --repo bad --sha nope --name merge-gate
```

Expected: tests pass; invalid CLI input exits non-zero before network access.

- [ ] **Step 5: Commit the waiter**

```bash
git add scripts/ci/wait-for-check-run.mjs tests/wait-for-check-run.test.ts
git commit -m "feat(release): require exact SHA CI evidence"
```

---

### Task 6: Wire the full CI aggregate and release authorization

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/agentic-harness-config.test.ts`
- Modify: `tests/release-sentry-workflow.test.ts`

**Interfaces:**
- Produces: stable CI check named `merge-gate` on PR heads and pushes to `main`.
- Consumes: `scripts/ci/assert-merge-gate.mjs`.
- Produces: release preflight `candidate_sha` used by
  `scripts/ci/wait-for-check-run.mjs`.

- [ ] **Step 1: Add failing workflow-structure tests**

Assert `ci.yml`:

```ts
expect(ci).toContain('merge-gate:');
expect(ci).toContain('name: merge-gate');
expect(ci).toContain('if: always()');
expect(ci).toContain('NEEDS_JSON: ${{ toJSON(needs) }}');
expect(ci).toContain('node scripts/ci/assert-merge-gate.mjs');
expect(ci).toContain('needs: [validate, electron-smoke, e2e, e2e-extension, e2e-electron, vscode-extension-e2e, docs]');
```

Assert required platform jobs no longer use PR-only conditions and that the
Dependabot-only allowed skip list is explicit.

Extend `release-sentry-workflow.test.ts` to assert:

```ts
expect(workflow).toContain('checks: read');
expect(workflow).toContain('id: candidate');
expect(workflow).toContain('candidate_sha=');
expect(workflow).toContain('node scripts/ci/wait-for-check-run.mjs');
expect(workflow).toContain('--name merge-gate');
expect(workflow).toContain('--sha "${{ steps.candidate.outputs.candidate_sha }}"');
```

- [ ] **Step 2: Verify workflow tests are red**

Run:

```bash
npx vitest run tests/agentic-harness-config.test.ts tests/release-sentry-workflow.test.ts
```

Expected: merge-gate and exact-SHA assertions fail.

- [ ] **Step 3: Make all required CI jobs run for merged-main SHAs**

Remove `github.event_name == 'pull_request'` from the `if` conditions of
`electron-smoke`, `e2e`, `e2e-extension`, `e2e-electron`, and
`vscode-extension-e2e`. Retain `github.actor != 'dependabot[bot]'` only for the
native Electron/VS Code jobs that require install scripts. Preview deployment
remains PR-only and is not part of the gate.

- [ ] **Step 4: Add the aggregate job**

Append after `docs`:

```yaml
  merge-gate:
    name: merge-gate
    if: always()
    needs: [validate, electron-smoke, e2e, e2e-extension, e2e-electron, vscode-extension-e2e, docs]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v7
      - name: Assert every required CI surface passed
        env:
          NEEDS_JSON: ${{ toJSON(needs) }}
          ALLOWED_SKIPPED_JOBS: ${{ github.actor == 'dependabot[bot]' && 'electron-smoke,e2e-electron,vscode-extension-e2e' || '' }}
        run: node scripts/ci/assert-merge-gate.mjs
```

- [ ] **Step 5: Compute and authorize the exact release candidate**

Grant `checks: read` to preflight. After checkout, add a candidate step that
resolves this precedence through Git:

```text
repair_release_tag
pull_request.merge_commit_sha
recover_stable_release_sha
github.sha
```

It must write a verified 40-hex `candidate_sha` to `GITHUB_OUTPUT`. Then add:

```yaml
      - name: Require successful full CI for the exact release candidate
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: >-
          node scripts/ci/wait-for-check-run.mjs
          --repo "${{ github.repository }}"
          --sha "${{ steps.candidate.outputs.candidate_sha }}"
          --name merge-gate
          --timeout-seconds 2400
          --poll-seconds 15
```

Use `candidate_sha` for candidate ancestry/version checks rather than resolving
a second independent ref. Keep the stable-secret, trusted release-bot, Sentry,
signing, draft-release, attestation, and repair-surface guards unchanged.

- [ ] **Step 6: Verify workflow tests and YAML parsing**

Run:

```bash
npx vitest run tests/ci-merge-gate.test.ts tests/wait-for-check-run.test.ts tests/agentic-harness-config.test.ts tests/release-sentry-workflow.test.ts
node -e "const YAML=require('yaml'); for(const f of ['.github/workflows/ci.yml','.github/workflows/release.yml']) YAML.parse(require('node:fs').readFileSync(f,'utf8'))"
```

Expected: all focused tests pass and both workflows parse.

- [ ] **Step 7: Commit CI and release wiring**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml tests/agentic-harness-config.test.ts tests/release-sentry-workflow.test.ts
git commit -m "feat(release): gate shipping on full exact SHA CI"
```

---

### Task 7: Align documentation and remove tracked local settings safely

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Create: `.codex/README.md`
- Modify: `docs/CI_CD.md`
- Modify: `openwiki/testing/index.md`
- Modify: `openwiki/operations/index.md`
- Create: `docs/adr/0028-codex-agentic-harness-and-shipping-gate.md`
- Modify: `docs/adr/0021-maintenance-harness.md`
- Modify: `docs-site/src/content/docs/architecture/adrs.mdx`
- Remove from tracking only: `.claude/settings.local.json`
- Extend test: `tests/agentic-harness-config.test.ts`

**Interfaces:**
- Produces: one accurate map of fast checks, local coverage-aware validation,
  complete CI merge gate, and exact-SHA release evidence.
- Produces: documented but unperformed live-ruleset follow-up.

- [ ] **Step 1: Add failing documentation-truth tests**

Assert all workflow docs name `npm run validate` as coverage-aware, reserve
“full CI” for `merge-gate`, and do not claim percent thresholds or that
`test:ci` disables thresholds. Assert `docs/CI_CD.md` labels live branch rules
as observed state and recommends requiring only `merge-gate` after merge.
Assert:

```ts
expect(execFileSync('git', ['ls-files', '--error-unmatch', '.claude/settings.local.json'], { cwd: repoRoot, stdio: 'ignore' })).toThrow;
```

Implement the tracked-file assertion without throwing at module evaluation:
use `spawnSync` and expect a non-zero status.

- [ ] **Step 2: Verify docs-truth tests are red**

Run `npx vitest run tests/agentic-harness-config.test.ts`.

Expected: stale-doc and tracked-local-file assertions fail.

- [ ] **Step 3: Update root and Codex guidance**

Keep `AGENTS.md` and `CLAUDE.md` synchronized on:

```text
npm run validate = local coverage-aware shipping gate
merge-gate = full CI matrix across web/Node/Electron/extensions/docs/packaging
release = exact candidate SHA must have successful merge-gate
.agents/skills = Codex repo skills
.codex/agents = read-only specialist reviewers
.codex/hooks.json + .codex/hooks = generated-file, format, compaction, stop gates
live GitHub ruleset mutation = deferred administrative follow-up
```

Create `.codex/README.md` with setup/trust notes (`/hooks`, `/mcp`), the pinned
MCP cache behavior, hook contracts, skill/agent map, and the deterministic gate
sequence. Do not document model pins or user secrets.

- [ ] **Step 4: Correct OpenWiki and CI/release documentation**

Replace old percentage-threshold claims with the current uncovered-item budgets
from `vitest.config.ts`; explain that `test:ci` enforces them. Distinguish fast
checks from `validate` and `merge-gate`. In `docs/CI_CD.md`, separate currently
observed rules from post-merge recommendations and include the ruleset deferral.

- [ ] **Step 5: Record the architectural decision**

Create ADR 0028 with:

```text
Status: Accepted, 2026-07-16
Context: Claude-only discovery, non-coverage validate, unaggregated CI, and release SHA gap
Decision: dual-runtime native entry points, coverage-aware validate, merge-gate, exact-SHA release wait
Consequences: slower local gate and main CI, explicit hook trust, stable future required check
Non-decision: no live ruleset mutation in this change
```

Mark ADR 0021 “Expanded by ADR 0028” without rewriting its historical decision.
Add ADR 0028 to both the timeline and LinkCard grid in `adrs.mdx`.

- [ ] **Step 6: Remove local settings from Git without reading it**

Run only:

```bash
git rm --cached .claude/settings.local.json
```

Do not run `cat`, `sed`, `rg`, `git show`, or diff-content commands on this
path. Confirm only tracking state with:

```bash
git ls-files --error-unmatch .claude/settings.local.json
```

Expected: non-zero. The ignored local file may remain in the worktree.

- [ ] **Step 7: Verify documentation and generated artifacts**

Run:

```bash
npx vitest run tests/agentic-harness-config.test.ts
npm run docs:check
npm run capabilities:check
npm run verify:opencollection-types
git diff --check
```

Expected: all pass; no codegen diff.

- [ ] **Step 8: Commit documentation and local-state hygiene**

```bash
git add AGENTS.md CLAUDE.md .codex/README.md docs/CI_CD.md openwiki/testing/index.md openwiki/operations/index.md docs/adr/0021-maintenance-harness.md docs/adr/0028-codex-agentic-harness-and-shipping-gate.md docs-site/src/content/docs/architecture/adrs.mdx tests/agentic-harness-config.test.ts
git add -u .claude/settings.local.json
git commit -m "docs: align agentic validation and shipping guidance"
```

---

### Task 8: Run final verification and fresh review

**Files:**
- Modify only if a verification failure identifies an in-scope defect.

**Interfaces:**
- Consumes every deliverable above.
- Produces evidence that the branch is ready for CI; publication is a separate
  user decision.

- [ ] **Step 1: Verify the fresh-checkout bootstrap path**

Delete only the ignored generated bundle, then run coverage directly:

```bash
rm src/features/scripts/lib/sandboxLibraries/bundle.generated.ts
npm run test:ci
```

Expected: the script regenerates the bundle, all tests pass, and coverage stays
within every budget.

- [ ] **Step 2: Run the full local shipping gate**

```bash
npm run validate
```

Expected: type-check all projects, Biome lint/format, codegen/capability checks,
coverage, and CLI tests all pass.

- [ ] **Step 3: Run build and harness-specific verification**

```bash
npm run build
npm run electron:compile
npm run size
npm run docs:check
node --check .codex/hooks/*.mjs scripts/ci/*.mjs
codex --strict-config doctor --json
node .codex/run-chrome-devtools-mcp.mjs --version
```

Expected: all commands pass; MCP reports `1.6.0`; no Codex project config/hook
parse warning.

- [ ] **Step 4: Run focused security, workflow, and harness tests**

```bash
npx vitest run tests/security tests/codex-hooks.test.ts tests/agentic-harness-config.test.ts tests/ci-merge-gate.test.ts tests/wait-for-check-run.test.ts tests/release-sentry-workflow.test.ts
```

Expected: all pass.

- [ ] **Step 5: Review the complete diff with fresh eyes**

Inspect `git diff main...HEAD --stat`, then the full diff excluding the unread
local settings file. Check:

```text
security: no SSRF/IPC/SecretRef/auth/signing relaxation
parity: web Worker, Node self-host, and Electron remain represented
hooks: apply_patch paths, worktree Git paths, bounded output/time, current JSON
CI: every required job reaches merge-gate on PR and main push
release: exact candidate SHA only; repair cannot borrow current-main evidence
docs: AGENTS/CLAUDE/OpenWiki/CI/ADR agree; live ruleset remains deferred
codegen: capability and OpenCollection outputs clean
```

- [ ] **Step 6: Commit any review-only corrections and re-run affected gates**

Use a conventional scoped commit that names the corrected subsystem. Never
amend prior commits. Re-run the focused test that caught the issue and then
`npm run validate`.

- [ ] **Step 7: Record final evidence**

Capture command, exit status, and concise result for every acceptance gate.
Do not claim CI-only cross-OS jobs passed locally; state that their workflow
structure is tested and branch CI remains the shipping proof.
