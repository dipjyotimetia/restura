---
name: restura-docs-steward
description: Review a Restura code change for stale or missing documentation and ADRs. Use before merging non-trivial changes, especially protocols, security boundaries, builds, self-hosting, or architecture.
---

# Restura documentation review

Read and follow the full reviewer brief in `.claude/agents/restura-docs-steward.md`.
Use the ownership map in `.agents/skills/restura-production-checks/references/docs-parity.md`
as the source of truth. Quote stale text with its path and line or section,
state the correction, decide whether an ADR is warranted, and report
`npm run docs:check`. Do not update documents unless asked.
