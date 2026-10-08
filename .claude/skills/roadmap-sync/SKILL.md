---
name: roadmap-sync
description: Add, update, audit, or re-status entries on Restura's public roadmap — the interactive tree at docs.restura.dev/roadmap (docs-site/src/data/product-tree.ts), the delivery plan, and docs/ROADMAP.md. Use whenever a feature ships, changes status, or gets dropped; when someone asks "is the roadmap up to date", "add X to the roadmap", "mark Y shipped", "what's missing from the roadmap", or wants future/exploring ideas added; and when editing the roadmap tree page's layout, styles, or animations (roadmap.astro, scripts/product-tree.ts, styles/tree.css). Also use after merging a notable feature PR, even if the user doesn't mention the roadmap.
---

# Roadmap sync

The roadmap is a public claim about the product. A wrong "shipped" badge or a line
implying a dependency that doesn't exist misleads users more than a missing entry,
so every change is evidence-first: verify in source, then edit data, then verify
the page.

## Where things live

| What | File |
|---|---|
| Entries, statuses, plans, tree parents, highlights, layout math | `docs-site/src/data/product-tree.ts` |
| Tree page markup (server-rendered) | `docs-site/src/pages/roadmap.astro` |
| Interaction: pan/zoom, popover, lineage trace, filters, hash links | `docs-site/src/scripts/product-tree.ts` |
| Styles and animations | `docs-site/src/styles/tree.css` |
| Per-feature icons (falls back to branch icon) | `docs-site/src/components/FeatureIcon.astro` |
| Other consumers of the data (keep `Feature` changes additive) | `components/DeliveryPlan.astro`, `components/RoadmapTeaser.astro`, `content/docs/overview/delivery-plan.mdx` |
| Prose roadmap that must agree with the tree | `docs/ROADMAP.md` |
| Data + UI tests | `docs-site/tests/product-tree.test.ts`, `docs-site/tests/product-tree-ui.test.ts` |
| Source of truth for web vs desktop support | `src/lib/shared/capabilities.ts` |

Print the current inventory (id, branch, status, platforms, tree depth/parent) with:

```bash
npx tsx .claude/skills/roadmap-sync/scripts/inventory.mts          # all
npx tsx .claude/skills/roadmap-sync/scripts/inventory.mts security # one branch
```

## Data rules

Each entry is `entry(branch, id, title, description, status, platforms, href?, prerequisites?, plan?)`.

- **Status must match code, not intent.** `shipped` means a user can do it today
  end to end. If a primitive exists but nothing calls it (e.g. a validator with no
  runtime caller, a provider never selected), it is `in-progress` or `planned`.
  Check `capabilities.ts` for platform splits — a capability that is desktop-only
  there must not list Web.
- **Unshipped entries need a `plan`**: `today` (what exists now, in plain words) and
  ≥3 milestones; milestones are `done()`/`todo()` checked against source, never
  estimated. `in-progress` needs at least one done and at least one todo. Shipped
  entries have no plan. Tests enforce all of this.
- **Future ideas** (illustrative, not committed) use `exploring`, not `planned`.
  Before adding one, grep `src/ shared/ electron/main cli/` to make sure it isn't
  already built — several "ideas" in past audits (OAuth PKCE/device flow, gRPC-Web,
  OpenAPI import, response diff, doc generation, cloud secret providers) already
  shipped. If part of it ships, add the shipped part and make the idea its child.
- **Tree parents** (`parents` map, after the `features` array) mean "builds on",
  same branch only. Only name a parent the feature genuinely extends; unrelated
  siblings (NATS under Kafka, command palette under Web app) stay at the hub.
  Without a parent, an entry hangs from its first same-branch prerequisite, then
  the hub. Cross-branch relationships go in `prerequisites`, which draw as dashed
  lines on selection.
- **`href`** must point to an existing `docs-site/src/content/docs/**/*.mdx` page
  (test-enforced); omit it rather than invent a page.
- **Prefer extending an entry** over adding a near-duplicate (e.g. VS Code CodeLens
  belongs in the `vscode` description). Add a new entry when it is a capability a
  user would look for by name.
- Bump `reviewedOn` when you re-verify statuses. Add notable merged work to
  `highlights` (newest first, with the PR number).
- Avoid words in new descriptions that break search tests: a word starting with
  "har" (the `HAR` search must return only `har-import`).

## Workflow

1. **Audit** (for "review/is it up to date/what's missing" requests). Run the
   inventory script, then compare against the code. For a full audit, split by
   branch and use read-only parallel subagents (tell them not to edit or commit),
   e.g. protocols+security / collections+automation+AI / platforms+app-wide UI, plus
   one for future ideas that must grep before proposing. Ask each for proposed
   id, branch, title, one-sentence description, platforms, and evidence paths.
2. **Verify** every claim yourself — open or `ls` the evidence files and check the
   relevant `capabilities.ts` keys. Drop anything you can't confirm, and resolve
   conflicts between agents (one agent's "idea" is often another's shipped
   feature).
3. **Edit** `product-tree.ts`: add/update entries, parents, plans. Run
   `./node_modules/.bin/biome format --write docs-site/src/data/product-tree.ts`.
4. **Update tests only where they pin editorial data on purpose** (e.g. the
   shipped-security list in `product-tree.test.ts`); never weaken the structural
   checks (unique ids, acyclic, same-branch parents, no overlap, plans).
5. **Sync `docs/ROADMAP.md`** so the prose agrees with the tree (shipped sections,
   in-progress, planned, exploring).
6. **Gates** (from repo root):
   ```bash
   npm run docs:test     # data + UI tests
   npm run docs:build    # Astro build
   ```
7. **Look at it.** `cd docs-site && npx astro preview --port 4329` (after build),
   then screenshot `/roadmap/` at 1440×1000 and 390×844 with Playwright. Load
   via `about:blank` first — re-navigating to the same URL with a hash does not
   reload the page and you'll see stale JS. Check the new nodes appear under the
   right parent, `/roadmap/#<id>` opens that node, and `/overview/delivery-plan/`
   shows new unshipped plans. Stop the preview server afterwards.

Report what changed per branch (added shipped / re-statused / new ideas), what
you dropped and why, and gate results. Don't commit unless asked.

## Changing the tree page itself

Read `references/tree-ui.md` before editing `roadmap.astro`,
`scripts/product-tree.ts`, or `styles/tree.css` — it explains the layout model,
the animation contracts, and the regressions that are easy to reintroduce.
