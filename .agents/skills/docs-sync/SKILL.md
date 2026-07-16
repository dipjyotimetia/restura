---
name: docs-sync
description: Update every Restura documentation surface made stale by a code or workflow change, using the repository documentation ownership map.
---

# Synchronize Restura documentation

Load `.agents/skills/restura-production-checks/references/docs-parity.md` and request a
`restura-docs-steward` review of the complete diff. Update only the stale
sections it identifies across root guidance, `docs/`, OpenWiki, `docs-site/`,
and generated capability documentation. Architectural decisions require a new
numbered ADR and matching timeline plus LinkCard entry in
`docs-site/src/content/docs/architecture/adrs.mdx`. Run `npm run docs:check` and
the relevant codegen check. If no content is stale, report that without
inventing edits.
