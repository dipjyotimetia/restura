# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It holds only invariants and routing; detail loads on demand from `docs/agents/` and `.claude/skills/` (progressive disclosure — keep it that way: new subsystem prose goes in a reference doc, not here).

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
- **Electron main**: files computing `__dirname`-relative paths stay at the `electron/main/` root. IPC handlers validate with Zod (`ipc/validators/`); register/dispose pair in `main.ts` `IPC_MODULES`.
- **Worker**: production needs `WORKER_PROXY_TOKEN` or `REQUIRE_CF_ACCESS=true`. **Never** put `DEV_BYPASS_AUTH` in `wrangler.jsonc`. `nodeEntry` must `Object.assign` onto `c.env`, never reassign.
- **AI**: assistant is Electron-first — there is no `/api/ai` Worker route. AI Lab is Electron-only; its `http-exec` target runs through the real `requestExecutor` (no parallel HTTP path); provider keys are `SecretRef` handles; localhost carve-out only for local runtimes.
- **Boundaries**: `shared/` is the runtime-neutral floor; Worker, Electron main and CLI never import renderer `src/`. Ratchets may only go down.
- **TS**: strict (`noUncheckedIndexedAccess` etc.); `exactOptionalPropertyTypes` off except `src/features/http/tsconfig.json`. Path alias `@/` → `src/`.

## Where to read before working on…

| Area | Load |
|---|---|
| Any feature / new protocol / auth / importer | `restura-feature-dev` skill (+ its `references/`) |
| Architecture tour, subsystem notes, full commands | `docs/agents/architecture.md` |
| Verifying / shipping / release gates | `restura-production-checks` skill, `/ship-check` |
| UI change | `verify-ui-change` skill — compiling is not verified |
| Multi-PR / parallel agent delivery | `docs/agents/delivery.md`, `/batch-ship` |
| Security boundary (SSRF, IPC, secrets, sandboxes) | `restura-security-auditor` agent, `tests/security/` |
| Domain terms, ADRs | `CONTEXT.md`, `docs/adr/`, `docs/agents/domain.md` |
| CLI | `cli/README.md` (canonical) |

## Testing

Vitest (jsdom) with colocated `*.test.ts(x)`; tests importing `worker/` live under `worker/`. Playwright e2e in `e2e/` (`workers: 1` deliberate; `.dev.vars` must exist before the dev server boots). Desktop e2e in `e2e-electron/`. Security regressions in `tests/security/`. Inline snapshots only (`*.snap` is gitignored).

## Agent loop playbook (short)

Full version: `docs/agents/delivery.md`.

- **Verify before done**; iterate against deterministic gates (`/fix-until-green`), not "looks done".
- **Plan by file ownership**: two PRs touching the same non-registry file are one PR; ≤5 PRs per batch; independent PRs off `main`, stack only real dependencies (≤3).
- **Review the combined result**: `npm run integration-check` + `/ship-check <branches>`; seam bugs are invisible per branch.
- **Merge via the merge lane** (`gh pr merge <n> --auto --squash`); `--admin` is emergencies only and is hook-gated.
- **Subagents that edit code**: `npm run worktree:setup`; explicit `git add <paths>`; red-first tests; no push/PR/`gh` mutations; report branch, worktree, SHA. Brief them fully — they only know the prompt.
- **Encode fixes upward**: when a loop misses the bar, fix the skill/hook/doc, not just the instance.

## Summary instructions (for context compaction)

When this conversation is summarized to free context, **preserve** the following — they are load-bearing for Restura work and expensive to reconstruct:

- **The task objective and acceptance criteria**, and which **harness(es)** are in scope: web (Cloudflare Worker), self-host (Node entry), Electron (IPC). Parity across them is the #1 bug class — never drop "this also needs the other harness wired."
- **Files read or modified**, and any pending edits not yet applied.
- **Security-boundary decisions**: SSRF/`url-validation` changes, new outbound transports, Electron IPC validation (`createValidatedHandler`), DNS/broker guards, `SecretRef` handling. These must survive summarization verbatim.
- **Gate results and failures** with `file:line`: `type-check:all` (not just renderer `type-check`), `lint`, the security suite, `capabilities:check`, `verify:opencollection-types`.
- **Codegen state**: whether `capabilities.ts` → `CAPABILITY_MATRIX.md` or the OpenCollection types still need regenerating (never hand-edit the generated files).
- **Decisions and their reasoning**, especially any ADR that the change warrants.

Drop verbose tool output (full file dumps, passing test logs) before dropping any of the above.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

## Agent skills

### Issue tracker

Issues live in GitHub Issues for dipjyotimetia/restura (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
