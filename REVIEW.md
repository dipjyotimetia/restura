# REVIEW.md — what a reviewer must know about this repo

Code-owner brief for every automated or human review of Restura. The `code-review` skill, `/ship-check` and the CI review jobs load it. Keep it short; detail belongs in `CLAUDE.md`, `docs/agents/` and the skills.

## What failure looks like here

Each area has one dominant way of being wrong. Look for that first.

| Area | It fails when… |
|---|---|
| `shared/protocol/` | **it diverges**: web Worker, Node self-host, Electron and CLI no longer behave the same, or a backend-only concern (PAC, SOCKS, mTLS, DNS guard) leaks into `shared/`. |
| `cli/src/runner/executors/` | **it is silent**: the CLI drops, downgrades or skips something the app rejects explicitly (auth it cannot sign, a cap, a guard). Parity failures must fail loudly. |
| `worker/` | **it bypasses**: a route reachable without `WORKER_PROXY_TOKEN` / CF Access, the SSRF guard (`url-validation.ts`) skipped, or `c.env` reassigned instead of `Object.assign`ed. |
| `electron/main/` | **it is unvalidated or half-wired**: an IPC handler without a Zod schema + `createValidatedHandler`, or missing its preload module / `electron/types/api/` type (then `window.electron.x` is undefined at runtime with no type error). |
| Secrets (`SecretRef`, handle stores) | **it leaks**: plaintext reaching the renderer, logs, errors or exports where a handle should flow. |
| Stores / persistence | **it rots**: new `window.localStorage` use, or persisted shapes without Zod validation and a migration. |
| `src/lib/shared/capabilities/` | **it lies about platforms**: a platform difference not declared there, or the generated matrix hand-edited. |
| Docs (`docs/`, `docs-site/`, root `*.md`) | **it lies**: text that no longer matches the code or the CLI. |
| Tests | **it mocks the seam away**: the test passes because the harness boundary it should exercise is stubbed. |
| `.github/workflows/`, `scripts/merge-lane.mjs`, hooks | **it widens access**: new write permissions, secrets in logs, a gate that can be skipped. |

## Rules for findings

- **Evidence or nothing.** Every finding cites a `file:line` the reviewer actually read and a concrete scenario (input → wrong output / crash / silent drop). Never infer a bug from a file name, a path pattern or a missing word in the diff.
- **Severity tags.** `Important` = must fix before merge (blocking). `Nit` = non-blocking. `Pre-existing` = a real bug in code the change did not introduce; report it once, never as blocking, never as the author's fault.
- **Caps.** At most **5 Nits** per review, grouped by class (one finding listing every site), and at most **3 Pre-existing**. Style, diagnostics and cleanup are never Important.
- **Tooling already enforces** Biome formatting/lint, `tsc --strict`, `npm run architecture:check` (boundaries, cycles, ratchets), codegen freshness (`capabilities:check`, `verify:opencollection-types`) and generated-file edits (hook). Do not re-report what they catch.
- **Bug class, not instances.** When the same defect appears at several sites, post one finding that lists all sites, so the author fixes the class.
- **Count first, then plain words.** The summary starts with the number of findings per tag. When there is nothing to fix, say exactly that: `Nothing to fix.`

## Paths to skip

Generated, vendored or evidence-only files; the diff command in the `code-review` skill excludes them:

`package-lock.json`, `openwiki/**`, `docs/CAPABILITY_MATRIX.md`, `shared/opencollection/spec-types.ts`, `e2e/mocks/proto/gen/**`, `**/*.generated.ts`, `**/*.snap`, `evals/harness/fixtures/**`, `evals/harness/baselines/**`, `.claude/metrics/**`, `vendor/**`.

## Review depth

The `code-review` skill picks **Quick / Standard / Deep** from the diff, not from the author (see its SKILL.md). Any change under the paths below is **Deep** regardless of size, because one missed bug there costs more than the extra review:

`shared/protocol/`, `electron/main/security/`, `electron/main/ipc/`, `electron/main/storage/userdata-guard.ts`, `worker/` (auth, proxy, `dns-guard-node.ts`), `cli/src/runner/executors/`, `src/lib/shared/capabilities/`, secret stores, sandboxes, `.github/workflows/`, `scripts/merge-lane.mjs`, `.claude/hooks/`.

## Rounds

A reviewer and an agent author can loop forever. Later rounds review only the diff since the last reviewed sha plus previously flagged lines, never repeat a finding already posted, and after **three rounds** the review says so and asks the author to reconsider the approach instead of patching again.
