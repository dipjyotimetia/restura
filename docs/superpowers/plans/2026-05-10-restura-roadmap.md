# Restura — "Migration Target" Roadmap

> Master roadmap for the work derived from the architecture review on 2026-05-10. Each phase below is a separate, individually-shippable plan. Phases are sequenced so that each unlocks the next.

## Positioning (one sentence)

**Restura is the multi-protocol API client that lives in your repo. Every protocol your team uses. No account. No cloud. Just YAML and git.**

## Phase Map

| #   | Plan                                          | Dependency | Outcome                                                                                                                                          | Plan file                                         |
| --- | --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 0   | **OpenCollection Foundation**                 | —          | Restura speaks OpenCollection v1.0.0 natively. Bruno 3.1+ repos open and roundtrip cleanly.                                                      | `2026-05-10-phase-0-opencollection-foundation.md` |
| 1   | **Workspace = Git Repo**                      | 0          | `restura init` scaffolds a git-ready workspace; `${{ secrets.X }}` template syntax with encrypted `.restura/secrets.enc`; in-app "Open Repo" UX. | `2026-05-10-phase-1-git-workspace.md` (TBD)       |
| 2   | **Bruno Legacy + cURL + HAR Import**          | 0          | One-click import from `.bru` DSL files, raw cURL strings, and HAR captures.                                                                      | `2026-05-10-phase-2-importers.md` (TBD)           |
| 3   | **CLI Runner Parity**                         | 0          | `@restura/cli` executes HTTP **and** gRPC/SSE/MCP/WebSocket requests with full QuickJS script support. JUnit/JSON/HTML reporters. CI-ready.      | `2026-05-10-phase-3-cli-runner.md` (TBD)          |
| 4   | **Auth Completion**                           | 0          | OAuth1.0a, NTLM, WSSE, Hawk, ASAP, Akamai EdgeGrid, OAuth2 silent refresh, mTLS per-environment.                                                 | `2026-05-10-phase-4-auth.md` (TBD)                |
| 5   | **Streaming + Large-Response UX**             | —          | Virtualized response viewer for >100MB streams; no truncation; on-disk spillover (Electron); replayable WebSocket/SSE/gRPC streams.              | `2026-05-10-phase-5-streaming.md` (TBD)           |
| 6   | **Mock + Contract + Load via Embedded Tools** | 0          | Prism (mock) and k6 (load) ship as embedded binaries on Electron / Worker subprocess; contract testing against OpenAPI 3.2 + AsyncAPI.           | `2026-05-10-phase-6-mock-contract-load.md` (TBD)  |

## Sequencing rationale

- **Phase 0 is non-negotiable first.** Every later phase reads/writes the file format. Doing Phase 0 second means rewriting work.
- Phases 1–4 are each independently mergeable after Phase 0.
- Phase 5 (streaming UX) has no Phase 0 dependency and can run in parallel.
- Phase 6 (mock/contract/load) needs Phase 0 because contract tests live alongside requests in the repo.

## Out of scope (explicitly)

These appeared in the architecture review but are **not** on this roadmap:

- Cloud sync backend, workspaces, RBAC, SSO. The wedge is offline-first; building cloud is fighting Postman on its turf.
- Postman-style "API Hub" (public discovery network).
- AI Agent Builder / Flows. Bloat that competitors are losing on.
- Mobile app. Desktop + web is enough.

## Cross-phase invariants

Every plan must respect:

1. **Auto-mode safety:** No destructive disk operations without confirmation. The git-native promise is broken if a save deletes a user's hand-written YAML.
2. **Worker ↔ Electron parity:** Any new protocol/auth method must work in both runtimes (or explicitly document the desktop-only delta). The renderer cannot branch on `isElectron()` for behavior the user expects to be portable.
3. **Schema = source of truth:** OpenCollection JSON Schema is vendored at a pinned version. All Zod/TS types derive from it. No drift.
4. **Tests use real fixtures:** Vendored `tests/fixtures/opencollection/*` for every plan that touches the file format.
5. **Frequent commits, small PRs:** No mega-PRs. Each task in a plan corresponds to one logical commit.

## Status

- ✅ Phase 0 plan written (this commit)
- ⏳ Phases 1–6 plan files: stubs only; write each in detail at start of that phase

---

## Relationship to the 2026-05-08 roadmap

A prior roadmap (`2026-05-08-roadmap.md`) sequenced 6 internal-architecture plans. This new roadmap is **product-led** (migration target positioning); the prior one is **engineering-led** (debt cleanup). They are **complementary, not duplicative**. Mapping:

| 2026-05-08 plan (engineering)              | 2026-05-10 phase (product)       | Relationship                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: Shared protocol layer                   | (Phase 0 prerequisite)           | In flight on branch `refactor/shared-protocol-layer`. **Land first**; everything below assumes a unified handler.                                                                  |
| 2: Multi-tab store + storage consolidation | (independent)                    | Land independently. Tab state is renderer-only; OpenCollection format is disk-only. No collision.                                                                                  |
| 3: Security hardening                      | Phase 4 (Auth completion)        | Phase 4 adds OAuth1/NTLM/Hawk; old Plan 3 fixes the signing-at-wire problem. **Phase 4 must land after old Plan 3** so new auth methods are signed at the wire from day one.       |
| 4: Streaming + gRPC streaming + HTTP/2     | Phase 5 (Streaming UX)           | Same scope. **Treat as one plan.** Use the 2026-05-08 plan's tasks; Phase 5 in this roadmap can be deleted/marked superseded.                                                      |
| 5: CLI runner                              | Phase 3 (CLI runner parity)      | 2026-05-08 plan ships the foundation; my Phase 3 adds gRPC/SSE/MCP execution and OpenCollection input. **Phase 3 extends, doesn't replace.**                                       |
| 6: Plugins + docs/mock                     | Phase 6 (Mock + contract + load) | Different framing. Old Plan 6 builds the primitive (`restura mock`). Phase 6 here proposes integrating Prism/k6 instead of inventing — **review tradeoff before starting either**. |

**New work that wasn't in the 2026-05-08 roadmap:**

- **Phase 0** (OpenCollection foundation) — the schema migration is the single biggest format decision and was missing. Doing it now prevents rework in Phases 2/3/6.
- **Phase 1** (git workspace UX) — `restura init`, secrets file, "open repo" flow.
- **Phase 2** (Bruno legacy `.bru` + cURL + HAR importers).

**Recommended execution order combining both roadmaps:**

1. Finish 2026-05-08 Plan 1 (shared protocol) — already in flight.
2. **Phase 0 (OpenCollection foundation)** — this plan.
3. 2026-05-08 Plan 2 (multi-tab store) — independent, can run parallel with Phase 0.
4. Phase 1 (git workspace) + 2026-05-08 Plan 3 (security) — independent of each other; pair up.
5. Phase 2 (legacy importers) + Phase 3 (CLI parity built on 2026-05-08 Plan 5).
6. Phase 4 (auth) + 2026-05-08 Plan 4 / Phase 5 (streaming, treat as one).
7. Phase 6 / 2026-05-08 Plan 6 — decide build-vs-integrate first.
