---
name: restura-production-checks
description: Use before a Restura PR, merge, release, or deploy, and whenever deciding whether a branch is fully validated and safe to ship.
---

# Restura production checks

`npm run validate` is the local coverage-aware shipping gate. It runs all
TypeScript projects, Biome lint and format checks, both generated-artifact
checks, root Vitest with coverage budgets, and CLI tests. Plain
`npm run type-check` covers only the renderer.

The complete GitHub verdict is `merge-gate`. It aggregates core validation,
the Cloudflare Worker and shipped self-hosted image/API/SPA surface, Electron tests and
cross-OS packaging smoke, browser E2E, Chrome extension E2E, VS Code tests, and
documentation builds. A release must use a successful `merge-gate` from the
exact candidate SHA.

Before shipping:

1. Run `npm run validate`, `npm run build`, `npm run build:docker`,
   `npm run electron:compile`, and `npm run size`.
2. Run applicable browser/Electron E2E and the mapped security tests from
   `references/security-checklist.md`.
3. Request independent review from `restura-security-auditor`,
   `restura-parity-checker`, and `restura-docs-steward`, plus a fresh-context
   correctness review.
4. Confirm OpenCollection types and `docs/CAPABILITY_MATRIX.md` are generated
   from their sources rather than hand-edited.
5. Treat the live GitHub ruleset as external administrative state. This skill
   reports the documented follow-up but never mutates that ruleset implicitly.

See `references/verification-gates.md`, `security-checklist.md`,
`release-readiness.md`, and `docs-parity.md` for focused checklists.
