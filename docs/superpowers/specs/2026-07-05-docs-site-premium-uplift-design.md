# Docs-Site Testing Coverage & Premium Uplift — Design

**Status:** Approved, ready for implementation plan
**Date:** 2026-07-05
**Owner:** Dipjyoti Metia
**Scope:** `docs-site/` (Astro Starlight, docs.restura.dev) content and IA only. No changes to the app, worker, or electron source; no changes to root-level docs (`CONTRIBUTING.md`, `CI_CD.md`, `docs/*.md`) other than adding a few cross-links from docs-site.
**Platform:** N/A (documentation site).

---

## 1. Goal

Two problems, one pass:

1. **Coverage gap.** Docs-site has zero mention of how Restura tests itself — no `echo-local` (the full-protocol local dev upstream), no Vitest, no Playwright, no `e2e-electron`, no security/contract tests, no CI gate (`npm run validate`). The existing "Mock server" guide is unrelated (a _product feature_ for replaying recorded responses, not the repo's test infrastructure). There's also no "Contributing" section anywhere in docs-site, despite a real `CONTRIBUTING.md` at the repo root.
2. **Premium bar, applied everywhere.** The visual design system ("Strata glass": gradient orbs, glass cards, scroll-reveal motion, per-protocol accents — see `docs-site/src/styles/custom.css`) is already strong but was applied with the landing page as the showcase. Several content pages are thin (protocols/`socket-io.mdx` 29 lines, `sse.mdx` 31, `graphql.mdx` 34 vs. `http.mdx` 68) and the site has no unifying, written style guide — it happens to be consistent today because one person wrote it, which won't hold once other contributors edit it.

This pass adds a new **Testing & Quality** section and a new **Contributing** section, brings every existing page to one explicit style bar (not a rewrite of good prose for its own sake — see §4), and adds landing-page surface for the new sections.

## 2. Non-goals

- No changes to `CONTRIBUTING.md`, `CI_CD.md`, or any root `docs/*.md` file content — docs-site _links to_ these as sources of truth rather than duplicating them. (New docs-site pages summarize and link; the canonical detail stays in the linked file.)
- No new Astro components/design-system primitives beyond what's needed to present testing content (e.g. reusing existing `Card`/`CardGrid`/`Aside`/`Badge`/tables — a testing-pyramid visual, if needed, is a Mermaid diagram via the already-wired `astro-mermaid`, not a new component).
- No visual redesign of the glass/motion system itself — it's already premium; this pass _extends its reach_ to under-treated pages, it doesn't replace it.
- No app-side, worker-side, or Electron-side code changes. Nothing in `src/`, `worker/`, or `electron/` is touched.
- No fabricated metrics/testimonials on the landing page — stays consistent with the site's existing honest tone (e.g. `overview/comparison.mdx`).
- No versioning/i18n/search-infra work.

## 3. Decisions (locked during brainstorm)

| Decision                               | Choice                                                                                                                                                                                                                                                  | Reason                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience for Testing & Quality section | Both: a trust-facing overview page first, contributor how-to pages beneath it                                                                                                                                                                           | Evaluators want "is this robust" answered without a tutorial; contributors need the actual commands. One page serves the first audience, the rest serve the second.                                                                                                                                                 |
| Rewrite depth                          | "Comprehensive" = every page reviewed and brought to a written style bar (frontmatter, structure, cross-links), not "delete and re-author everything"                                                                                                   | Several existing pages (`scripts.mdx`, `what-is-restura.mdx`) are already at the target bar; rewriting good prose for its own sake wastes effort and risks regressions. Comprehensive means _coverage_ (every page touched, held to the bar, linked into the new IA) not _prose churn on pages that don't need it_. |
| Thin protocol pages                    | Real content expansion (parity with `http.mdx`'s depth: gotchas, auth interplay, a link to the matching `echo-local` port for hands-on testing)                                                                                                         | `socket-io.mdx`/`sse.mdx`/`graphql.mdx` read as afterthoughts today; that's a real gap, not a style-only issue.                                                                                                                                                                                                     |
| New-page grounding                     | Testing & Quality pages are authored from the actual source (`echo-local/README.md`, `tests/security/`, `tests/contract/`, `e2e/`, `e2e-electron/`, `CONTRIBUTING.md`, `CI_CD.md`, `package.json` scripts) — not paraphrased from CLAUDE.md or invented | Confidently-wrong infra docs are worse than no docs; every command/port/path in the new pages must exist in the repo as written.                                                                                                                                                                                    |
| Testing section placement              | New top-level sidebar section "Testing & Quality," positioned after "Architecture" and before "Self-hosting"                                                                                                                                            | Sits naturally next to Architecture/Security (same "how is this built" register) without pushing user-facing Guides further down.                                                                                                                                                                                   |
| Contributing section placement         | New top-level sidebar section "Contributing," last (after Reference)                                                                                                                                                                                    | Contributor-facing, not part of the primary user journey — belongs at the end, same convention as most doc sites (Astro, Vite, etc.).                                                                                                                                                                               |
| Style guide                            | Written once as a shared artifact before any page work starts, and referenced by every subsequent authoring step                                                                                                                                        | The site currently reads as one voice because one person wrote it; that has to become an explicit, checkable artifact once "comprehensive" means touching every page.                                                                                                                                               |
| Landing page changes                   | Add one new card/section pointing at the Testing & Quality overview (the concrete answer to "make this robust") + a Contributing `LinkCard` in "Up next"                                                                                                | Directly serves the ask ("uplift... to make this application robust") by surfacing the new section, not by adding unrelated hero/marketing changes.                                                                                                                                                                 |
| Execution                              | Claude Code Workflow tool (multi-agent), phased: research → style guide → page work (pipelined) → consistency verify → fix → build verify                                                                                                               | User opted in explicitly, given the ~65-file scope. Style guide is authored before fan-out specifically to avoid the incoherence risk of parallel authors.                                                                                                                                                          |
| Isolation                              | New git worktree + branch, work happens there; no push/PR/merge without a separate explicit ask once done                                                                                                                                               | Matches repo convention (`using-git-worktrees` skill) and the "confirm before shared-state actions" default.                                                                                                                                                                                                        |

## 4. Information architecture

New sidebar sections in `docs-site/astro.config.mjs` (inserted between "Architecture" and "Self-hosting", and after "Reference" respectively):

```
Testing & Quality
├─ Overview                     testing/overview
├─ Local test stack             testing/local-stack        (echo-local)
├─ Unit & integration tests     testing/unit-integration    (Vitest)
├─ End-to-end tests             testing/end-to-end          (Playwright + e2e-electron)
├─ Security tests               testing/security             (tests/security/)
└─ Contract tests & CI          testing/contract-and-ci     (tests/contract/, npm run validate, CI_CD.md)

Contributing
├─ Overview                     contributing/overview        (points at CONTRIBUTING.md)
└─ Development setup            contributing/dev-setup       (Node 24+, npm install, dev commands, which tsconfig covers what)
```

### Page-by-page content grounding (source of truth for each new page)

- **`testing/overview`** — narrative synthesis, no new facts: the shape of the pyramid (unit/integration → contract → security → e2e web → e2e desktop → CI gate), one paragraph each, linking down. This is the only "trust" page — everything below it is a how-to.
- **`testing/local-stack`** — built from `echo-local/README.md`: what it is, `make setup` / `make echo-local`, the ports table (HTTP/HTTPS/mTLS/proxy/gRPC/WS/wss/Socket.IO/MCP/MQTT/Kafka), TLS/mTLS/custom-CA, `TEST_AUTH_FIXTURES` credentials, Docker-backed Kafka (Redpanda)/MQTT (EMQX), the generated importable collection, and what's driven manually (WS/Socket.IO/MQTT/Kafka/OAuth2/WSSE/OAuth1/Digest/NTLM — per the README's own "driven manually" section).
- **`testing/unit-integration`** — Vitest in jsdom, colocated `*.test.ts(x)`, `tests/setup.ts`, React Testing Library, `npm run test` / `test:run` / `test:coverage` / `test:ui`.
- **`testing/end-to-end`** — two harnesses, why both exist: Playwright `e2e/` (boots dev server via `webServer`, `workers: 1`/`fullyParallel: false` because suites share dev-server state, `real-*.spec.ts` hit live upstreams/echo Worker) vs. `e2e-electron/` (`_electron` launch of the unpacked prod build, native gRPC dev server on :50051 since the echo Worker's Connect endpoint is web-only, Kafka/MQTT specs auto-bring-up Dockerised brokers via the `brokers` fixture and skip if Docker is absent).
- **`testing/security`** — `tests/security/` file-by-file (ssrf, path-traversal, ai-redaction, capture-redaction, secret-storage-routing, socketio-dns-pinning, sse-proxy-routing, http-executor-no-fallback, response-viewer-sandbox, visualizer-sandbox, ai-lab-localhost-policy) — one line each on what regression it guards, linking to `architecture/security.mdx` for the underlying design.
- **`testing/contract-and-ci`** — `tests/contract/` (fetchers/upstream + the two `.contract.test.ts` files), `verify:opencollection-types`, `capabilities:check`, then `npm run validate` as the CI gate — linking to `CI_CD.md` for the full pipeline rather than re-describing it.
- **`contributing/overview`** — summarizes and links `CONTRIBUTING.md` (Code of Conduct, branch naming, commit format, PR process) — does not re-host its content.
- **`contributing/dev-setup`** — Node >=24, npm install, the dev commands already listed in root `CLAUDE.md`/`README.md`, plus which `tsconfig` covers what (the `type-check` vs `type-check:all` gotcha, since it's a real and non-obvious trap).

## 5. Style guide (shared artifact, authored before fan-out)

Written to `docs-site/` as a short internal reference the workflow's page-authoring agents load before writing (not published as a site page). Codifies what's already implicit in the best existing pages (`scripts.mdx`, `what-is-restura.mdx`):

- Second person, terse, technical. No first-person "I" outside the landing page's existing origin story.
- Bold key terms inline rather than long prose paragraphs; bullet lists for enumerable facts.
- `<Aside type="tip|note|caution|danger">` for gotchas/caveats, not buried in prose.
- `<Badge text="desktop only">` (or similar) on any platform-scoped feature, matching existing usage in `mock-server.mdx`.
- Every page ends with `## Related` or `## Next` — 2-5 links, no more.
- Frontmatter: `title` (2-4 words) + one-sentence `description` that could stand alone as a search-result snippet.
- No invented numbers/stats. If a claim needs a number (test count, coverage %), it must be sourced from an actual command output at authoring time, not asserted — and preferably avoided in favor of a stable qualitative claim, since counts drift.
- Tables for anything with >3 comparable rows (ports, credentials, capability matrices) over prose.

## 6. Landing page changes

In `docs-site/src/content/docs/index.mdx`:

- One addition to the "Why Restura" `CardGrid`: a card (e.g. "Tested like it matters" / icon `seti:check`) — one sentence pointing at the pyramid, linking to `/testing/overview/`.
- One addition to the "Up next" `CardGrid`: a `LinkCard` to `/contributing/overview/`.
- No hero/tagline/other landing changes — those are already at the target bar and out of scope per §2.

## 7. Execution plan (Workflow phases)

1. **Research (parallel, read-only)** — agents read `echo-local/README.md` + relevant scripts, `tests/security/*`, `tests/contract/*`, `e2e/README.md` + configs, `e2e-electron/*`, `CONTRIBUTING.md`, `CI_CD.md`, package.json scripts — return structured facts (no prose yet) per topic, to ground phase 3 and prevent hallucinated commands/ports.
2. **Style guide** — single agent authors the style-guide artifact from §5, informed by re-reading `scripts.mdx`/`what-is-restura.mdx`.
3. **Page work (pipelined per page/section)**, each referencing the style guide + its research bundle:
   - New Testing & Quality pages (6) and Contributing pages (2).
   - Thin protocol pages expanded (`socket-io.mdx`, `sse.mdx`, `graphql.mdx`, and any other page found short during research).
   - Structural/frontmatter/cross-link pass on every remaining existing page (guides, protocols, architecture, ADRs, self-hosting, reference) — link-only touch where content is already at the bar.
   - `astro.config.mjs` sidebar update (single agent — shared file, not parallelized) + landing page additions (§6).
4. **Consistency verify (parallel)** — agents check the style guide's rules (frontmatter shape, Related/Next presence, tone, no first-person outside landing, terminology: "Restura", protocol names, command names) across all touched pages; findings recorded.
5. **Fix** — apply verify findings.
6. **Build verification (real, not simulated)** — `cd docs-site && npm run check && npm run build` must both pass; broken internal links (`editLink`/sidebar slugs vs. actual file paths) are the most likely failure mode given the volume of new/moved pages.

## 8. Testing / verification

- `docs-site`: `npm run check` (Astro content + type check) and `npm run build` (renders every page — Starlight will fail the build on broken internal links/malformed frontmatter) are the hard gates.
- Manual spot-check: dev server (`npm run dev` in `docs-site/`), visually confirm the new sections render with the existing glass/motion system applied (no unstyled/broken pages), and that the landing page's two new cards look consistent with existing `CardGrid`/`LinkCard` styling.
- No claim in the new Testing & Quality pages should reference a file, port, command, or script that doesn't exist — this is checked during the consistency-verify phase by re-grepping the repo for each cited path/command, not just trusted from the research phase.

## 9. Open risks / things to watch

- **Volume risk**: ~65 existing files + 8 new + `astro.config.mjs` + `index.mdx` is a lot of surface for one pass; the pipelined-per-page execution (§7.3) is chosen specifically so slow pages don't block fast ones, but the consistency-verify phase (§7.4) is what actually catches drift — it is not optional even though it adds a round-trip.
- **Astro 7 / Starlight peer-override fragility** (documented in `docs-site/README.md`): adding pages doesn't touch dependencies, but a `npm install` inside the worktree must still resolve cleanly under the existing `overrides` block before `npm run build` can be trusted.
- **Sidebar collapse state**: the new "Testing & Quality" and "Contributing" top-level groups should default `collapsed: false` to match the existing "Overview"/"Protocols"/"Guides" pattern (only the ADR sub-list under Architecture is nested/collapsible today).
