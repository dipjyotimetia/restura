---
name: ship-check
description: Run Restura pre-shipping validation, builds, platform reviews, documentation review, and applicable end-to-end tests before publication.
---

# Restura ship check

Load `restura-production-checks`, inspect the diff against `main`, and collect a
single evidence table.

Run `npm run validate`, `npm run build`, `npm run build:docker`,
`npm run electron:compile`, and `npm run size`. Run browser and Electron E2E
when the diff touches a protocol, transport, or UI execution path. Confirm the
Cloudflare Worker, self-hosted Node, and Electron surfaces remain represented.

Before publication, run independent `restura-security-auditor`,
`restura-parity-checker`, and `restura-docs-steward` reviews plus a fresh-context
correctness review. Record skipped gates as skipped, never passed. The live
GitHub ruleset is outside this repository change and must not be mutated without
explicit authorization. Verdict is `READY` only when every applicable local
gate is green and the branch `merge-gate` succeeds for the exact SHA.
