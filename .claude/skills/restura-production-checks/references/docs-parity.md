# Docs parity — the ownership map

Nothing in `validate` or the pre-commit hook checks that documentation still matches the code. `npm run docs:check` is only `astro check` (broken links + types in `docs-site/`) — it does **not** verify content parity. So docs drift silently. This file is the map from a code change to the docs that own it. The `restura-docs-steward` agent and `/docs-sync` command both run off this map.

## Documentation surfaces

- `docs/` — long-form reference: `ARCHITECTURE.md`, `security.md`, `DEVELOPMENT_STANDARDS.md`, `BUILD_QUIRKS.md`, `SELF_HOSTING.md`, `DISTRIBUTION.md`, `notary.md`, `opencollection.md`, `postman-compat.md`, `workflows.md`, `API.md`, `ROADMAP.md`, `CHANGELOG.md`, generated `CAPABILITY_MATRIX.md`, `cli/`.
- `docs/adr/` — 20+ ADRs (`NNNN-title.md`).
- `docs-site/src/content/docs/` — Astro Starlight site: `overview/`, `protocols/` (one `.mdx` per protocol), `guides/`, `architecture/` (overview, shared-protocol, security, **adrs**), `reference/` (cli, postman-compat, opencollection, capability-matrix, api), `self-hosting/`.
- Root: `README.md`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.
- Agent context: `CLAUDE.md` (root, project instructions).

## Ownership map (code surface → docs that must change)

| You changed…                                                                                                   | Update these                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New protocol** (`src/features/<p>/`, `shared/protocol/<p>-proxy.ts`)                                         | `src/lib/shared/capabilities.ts` → regen `docs/CAPABILITY_MATRIX.md`; new `docs-site/.../protocols/<p>.mdx`; `docs-site/.../reference/capability-matrix.mdx`; mention in `docs/ARCHITECTURE.md` + `CLAUDE.md` protocol list |
| **Capability differs web/desktop**                                                                             | `capabilities.ts` (source of truth) → `npm run capabilities:matrix`                                                                                                                                                         |
| **Architectural decision** (new transport, security boundary, persistence, sandbox, build system, IPC pattern) | new `docs/adr/NNNN-*.md` **and** the timeline + `LinkCard` in `docs-site/.../architecture/adrs.mdx` (hand-maintained — drifts otherwise)                                                                                    |
| **Security boundary** (SSRF, IPC, secrets, sandbox, auth)                                                      | `docs/security.md`; `docs-site/.../architecture/security.mdx`; root `SECURITY.md` if disclosure/policy                                                                                                                      |
| **Shared protocol core**                                                                                       | `docs/ARCHITECTURE.md`; `docs-site/.../architecture/shared-protocol.mdx`                                                                                                                                                    |
| **Self-host / Docker / Worker entry**                                                                          | `docs/SELF_HOSTING.md`; `docs-site/.../self-hosting/{docker,reverse-proxy}.mdx`                                                                                                                                             |
| **Build / packaging / Electron dist**                                                                          | `docs/{BUILD_QUIRKS,DISTRIBUTION,notary}.md`                                                                                                                                                                                |
| **CLI**                                                                                                        | `docs/cli/*`; `docs-site/.../reference/cli.mdx`                                                                                                                                                                             |
| **Collection import/export**                                                                                   | `docs/{opencollection,postman-compat}.md`; `docs-site/.../reference/{opencollection,postman-compat}.mdx`                                                                                                                    |
| **npm scripts / commands / dev workflow**                                                                      | `CLAUDE.md` (Development Commands), `docs/ARCHITECTURE.md`, `README.md`, `docs/DEVELOPMENT_STANDARDS.md`                                                                                                                    |
| **Architecture invariant** (the "type-check covers all" class of claim)                                        | `CLAUDE.md`, `AGENTS.md`, `docs/ARCHITECTURE.md` — keep all three consistent                                                                                                                                                |
| **A user-facing feature/guide**                                                                                | the matching `docs-site/.../guides/*.mdx`                                                                                                                                                                                   |

## "Does this change warrant an ADR?"

Write an ADR when the change is a **decision with alternatives and lasting consequences**, not a routine edit. Triggers:

- A new transport/protocol or a new way of doing networking.
- A new security boundary or a change to an existing one (SSRF model, sandbox, secret storage, auth signing).
- A new persistence mechanism or store shape.
- A cross-cutting build/packaging/platform decision.
- Reversing or superseding an existing ADR (add a new one; mark the old superseded — don't silently edit).

Routine bug fixes, refactors, dependency bumps, and feature additions that follow an existing pattern do **not** need an ADR.

When you add `docs/adr/NNNN-*.md`: use the next number, date it, and **also** add the entry to the timeline + `LinkCard` grid in `docs-site/.../architecture/adrs.mdx`.

## Verify

After updating docs: `npm run docs:check` (links/types). There is no automated content-parity gate — the steward agent / this map is the check.
