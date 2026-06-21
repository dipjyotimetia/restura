---
description: Update every documentation surface a code change made stale — docs/, ADRs, docs-site, and root markdown — using Restura's doc-ownership map.
argument-hint: '[diff range | feature name] (default: current diff vs main)'
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, Task
---

Bring Restura's docs back into parity with the code. Scope: `$ARGUMENTS` (default: `git diff main...HEAD` plus working changes).

First invoke the `restura-production-checks` skill and read `references/docs-parity.md` (the ownership map). Then dispatch the `restura-docs-steward` agent on the diff to get the authoritative list of stale/missing docs and the ADR decision.

## Steps

1. **Detect drift** — run `restura-docs-steward` on the scope. It returns: stale docs (with the offending quote), missing docs, and whether an ADR is warranted.
2. **Update each surface** the steward flagged, following the ownership map in `references/docs-parity.md` (the single source — don't reproduce it here). A common, easily-missed one: an **architectural decision** needs a new `docs/adr/NNNN-*.md` AND an entry in the hand-maintained timeline + LinkCard grid in `docs-site/src/content/docs/architecture/adrs.mdx`.
3. **Match existing voice** — edit surgically; mirror the surrounding doc's tone and structure. Don't rewrite sections that aren't stale.
4. **ADR** — if warranted, create the next-numbered ADR (dated, with context/decision/consequences) and add its entry to `adrs.mdx`. If superseding, mark the old one superseded rather than editing it away.
5. **Verify** — `npm run docs:check` (astro links/types). If you regenerated the capability matrix, `npm run capabilities:check`.

## Output

List each file changed and the one-line reason. If no docs were stale, say so and stop — don't manufacture edits.
