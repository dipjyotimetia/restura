# AGENTS.md

This file provides guidance to Codex when working with code in this repository.
It mirrors `CLAUDE.md` for the Codex runtime. Both hold only invariants and
routing; detail loads on demand from `docs/agents/` and the skill files under
`.claude/skills/*/SKILL.md` (plain markdown — read them directly). Keep the two
in sync: an architectural change documented in one should be reflected in the
other.

Codex MCP context lives in `.codex/config.toml` (chrome-devtools).

## Project Overview

Restura is a multi-protocol API client — **HTTP/REST, GraphQL, gRPC, WebSocket, Socket.IO, SSE, Kafka, MQTT, MCP** — plus an **AI assistant** and an Electron-only **AI Lab** eval workbench. One React renderer ships to three targets: web (Cloudflare Pages + Worker), self-hosted Node/Docker, and Electron desktop. Restura can also act _as_ an MCP server. Node.js 24+.

## Commands you need most

```bash
npm run dev                 # Vite (5173) + Worker via Miniflare
npm run type-check:all      # ALL tsconfigs — what CI runs (`type-check` = renderer only)
npm run lint                # Biome
npm run test:run            # Vitest; single file: vitest run path/to/file.test.ts
npm run architecture:check  # runtime boundaries, cycles, size + pattern ratchets
npm run validate            # full product gate (policy + tests + all builds + size)
npm run capabilities:matrix # regen docs/CAPABILITY_MATRIX.md from capabilities.ts
npm run gen:opencollection-types
npm run electron:dev        # desktop dev
npm run worktree:setup      # first command in any linked worktree
npm run integration-check -- <branches>   # merge a batch in a throwaway worktree + run gates
```

Full catalogue (e2e, desktop e2e, echo stacks, Docker, deploy): `docs/agents/architecture.md`.

## Architecture invariants

- **One renderer, three backends.** Only transport differs, chosen by `isElectron()` (`src/lib/shared/platform.ts`). Web and self-host share one Hono app (`createApp` in `worker/app.ts`); desktop goes over IPC (`window.electron` → `electron/main/handlers/*`). The Worker is never bundled into Electron. Hash routing (works on `https://` and `file://`).
- **Protocol logic lives once in `shared/protocol/`** (SSRF guard `url-validation.ts`, header policy, body builder, auth signing at the wire, gRPC/MCP/SSE/AI orchestrators). Backends supply a thin `Fetcher`. New protocol = `shared/protocol/<name>-proxy.ts` + small Worker and Electron adapters. Electron-only capabilities (PAC, SOCKS, mTLS, custom CA, DNS guard, manual redirects) stay inside the Electron fetcher closure — keep `shared/` backend-agnostic.
- **Parity is the #1 bug class**: web Worker, self-host Node, Electron IPC **and the CLI** (`cli/src/runner/executors/*`) must behave the same, or fail explicitly. `src/lib/shared/capabilities.ts` is the source of truth for platform differences (codegen'd matrix — never hand-edit).
- **Secrets**: `SecretValue = string | SecretRef`; with a handle the renderer never sees plaintext (ADR-0007). No new persistence through `window.localStorage`; stores persist via Dexie (web) / encrypted electron-store (desktop), validated by Zod.
- **Electron main**: files computing `__dirname`-relative paths stay at the `electron/main/` root. A new IPC method needs all three parts: Zod schema + `createValidatedHandler` (`ipc/validators/`), a preload domain module, and a type under `electron/types/api/` composed into `ElectronAPI` — skip one and `window.electron.x` is undefined at runtime with no type error. Register/dispose pair in `main.ts` `IPC_MODULES`.
- **Worker**: production needs `WORKER_PROXY_TOKEN` or `REQUIRE_CF_ACCESS=true`. **Never** put `DEV_BYPASS_AUTH` in `wrangler.jsonc`. `nodeEntry` must `Object.assign` onto `c.env`, never reassign.
- **AI**: assistant is Electron-first — there is no `/api/ai` Worker route. AI Lab is Electron-only; its `http-exec` target runs through the real `requestExecutor` (no parallel HTTP path); provider keys are `SecretRef` handles; localhost carve-out only for local runtimes.
- **Boundaries**: `shared/` is the runtime-neutral floor; Worker, Electron main and CLI never import renderer `src/`. Ratchets may only go down.
- **TS**: strict (`noUncheckedIndexedAccess` etc.); `exactOptionalPropertyTypes` off except `src/features/http/tsconfig.json`. Path alias `@/` → `src/`.

## Where to read before working on…

| Area | Load |
|---|---|
| Any feature / new protocol / auth / importer | `.claude/skills/restura-feature-dev/SKILL.md` (+ `references/`) |
| Architecture tour, subsystem notes, full commands | `docs/agents/architecture.md` |
| Verifying / shipping / release gates | `.claude/skills/restura-production-checks/SKILL.md`, `.claude/skills/ship-check/SKILL.md` |
| Reviewing a diff / PR | `.claude/skills/code-review/SKILL.md`, `REVIEW.md` (what failure looks like per area, evidence rule, caps, depth, rounds) |
| UI change | `.claude/skills/verify-ui-change/SKILL.md` — compiling is not verified |
| Multi-PR / parallel agent delivery | `docs/agents/delivery.md`, `.claude/skills/batch-ship/SKILL.md` |
| Security boundary (SSRF, IPC, secrets, sandboxes) | `.claude/agents/restura-security-auditor.md`, `tests/security/` |
| Domain terms, ADRs | `CONTEXT.md`, `docs/adr/`, `docs/agents/domain.md` |
| CLI | `cli/README.md` (canonical) |

## Testing

Vitest (jsdom) with colocated `*.test.ts(x)`; tests importing `worker/` live under `worker/`. Playwright e2e in `e2e/` (`workers: 1` deliberate; `.dev.vars` must exist before the dev server boots). Desktop e2e in `e2e-electron/`. Security regressions in `tests/security/`. Inline snapshots only (`*.snap` is gitignored).

## Agent loop playbook (short)

Full version: `docs/agents/delivery.md`. Identical in `CLAUDE.md` and `AGENTS.md` — change both together.

- **Verify before done** — for renderer/UI changes, run the app (`npm run dev`), drive the change in a real browser and check the console (`verify-ui-change` skill); iterate against a deterministic gate (`npm run validate`, `/fix-until-green`) with an attempt cap, not "looks done".
- **Plan by file ownership** — two PRs touching the same non-registry file are one PR; ≤5 PRs per batch; independent PRs off `main`, stack only real dependencies (≤3 layers); one topic per branch/worktree.
- **Review the combined result** — `npm run integration-check -- <branches>` plus `/ship-check <branches>` (security per branch; correctness, parity and docs on the combined diff, plus a fresh-context code review per `.claude/skills/code-review/SKILL.md` — Correctness, Standards, Spec); seam bugs are invisible per branch.
- **Merge via the merge lane** (`gh pr merge <n> --auto --squash`); `--admin` is emergencies only and is hook-gated.
- **Subagents that edit code** — `npm run worktree:setup`; explicit `git add <paths>`; red-first tests; no push/PR/`gh` mutations (hook-enforced from `.claude/worktrees/`); report branch, worktree, SHA. Brief them fully — they only know the prompt.
- **Encode fixes upward** — when a loop misses the bar, fix the skill/hook/doc, not just the instance.

## When summarizing this conversation

Preserve: the task objective + which harness(es) are in scope (web Worker /
self-host Node / Electron) and that **parity across them** must hold; files
read/modified; security-boundary decisions (SSRF/`url-validation`, IPC
validation, `SecretRef`); gate results with `file:line` (`type-check:all`,
`lint`, security suite, `capabilities:check`); and whether codegen
(`capabilities.ts` / OpenCollection types) still needs regenerating. Drop
verbose tool output before dropping any of that. (Mirrors the fuller section in
CLAUDE.md.)

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

## Agent skills

Codex does not load `.claude/skills/`; read these files directly instead.

### Issue tracker

Issues live in GitHub Issues for dipjyotimetia/restura (via the `gh` CLI). Read `docs/agents/issue-tracker.md` for the workflow (labels, how to read and file issues).

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. Read `docs/agents/domain.md` for how to consume and extend them.
