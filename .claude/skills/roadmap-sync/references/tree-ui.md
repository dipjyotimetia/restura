# Roadmap tree UI — how it works and what breaks

Modelled on up.com.au/tree's *structure* (root → straight lines to branch hubs →
circular nodes with labels beneath, staggered parent→child offshoots) but in
Restura's cobalt tokens. Don't copy Up's art, logo treatment, or coral palette.

## Layout model (`product-tree.ts`, computed at build time)

- Per branch, features are placed depth-first: each node gets its own row, so a
  child sits directly below its parent, one `layout.depthStep` to the right.
  `featureGrid(f)` → `{column, depth, row}`; `featurePosition(f)` → **centre of the
  circle** (not a top-left corner).
- Branch width = `labelWidth + maxDepth * depthStep` (min `minBranchWidth`);
  hubs sit left-to-right using real widths (`branchLeft`, `branchWidth`).
- `edgePath(f)`: top-level nodes hang on a vertical spine from the hub; a parent's
  first child is reached diagonally, later siblings continue straight down from
  it. Siblings therefore **share line segments** — which is why the page draws
  shipped edges last (shared line stays solid up to the last shipped node).
- `depthStep` < `labelWidth` is safe only because no two nodes share a row; if
  you ever pack rows, labels and spines will collide (the no-overlap test catches
  label boxes, not lines).
- `fitScale`: fit width, allow vertical overflow up to 1.6× viewport height;
  phones (<640px) frame the first branch at ≤1×.

## Interaction (`scripts/product-tree.ts`)

- Details open as a **popover anchored beside the node** (`placePanel`, flips left
  near the right edge; bottom sheet when viewport < 640px). Opening never moves
  other nodes — do not reintroduce inline expansion that pushes cards down.
  `placePanel` is computed from `offset/scale`, so it is called from `paint()`.
- Direct clicks keep the camera; search, relationship links, and `#hash` pan to
  the node (`x = width/3`, fixed top margin).
- `panTo` clamps so the map stops a 40px margin past its edges; at the edge the
  wheel falls through to page scroll (test-enforced).
- A tap on empty map closes the details; a drag never opens a node
  (`suppressClick`).

## Animations (`styles/tree.css`) — each one carries meaning

- **Growth on load**: trunk draws, root links draw, then each branch grows down.
  Per-node delay comes from `grow()` in `roadmap.astro` (column, row, depth).
  Shipped edges *draw* (`tree-draw`), unshipped edges only *fade* — the entrance
  shows what exists. Nodes pop (`node-grow`) ~220ms after their edge.
  `tree-entered` is added after 2800ms so entrances don't replay.
- **Lineage trace on select**: `lineage()` clones trunk + branch root link +
  every ancestor edge into `#lineage-lines` and draws them in order (`--step`).
- **Select ripple** on the node ring; in-progress status dot pulses.
- **Filter**: edges into hidden nodes get `.dimmed` alongside the nodes.
- Everything is disabled by the global `prefers-reduced-motion` rule; the final
  state must still be correct with no animation (lineage solid, nodes visible).

## Gotchas

- **`pathLength="1"` only on solid paths.** Dashed (unshipped) edges must not have
  it, or `stroke-dasharray` becomes a fraction of each path's length and dash size
  varies per edge. That's why shipped edges get `pathLength=1` and others don't.
- Old cascading rules in `tree.css` can override new ones (e.g. a
  `.feature-node .status-dot.in-progress { position: relative }` once pulled the
  status badge into the ring centre). After CSS edits, screenshot an in-progress
  node.
- Keep the DOM contracts the script and tests rely on: `data-feature`,
  `data-card`, `data-status`, `data-edge`, `data-branch-edge`, `data-map-branch`,
  `#feature-detail`, `#dependency-lines`, `#lineage-lines`, `aria-expanded`.
- The UI test stubs `matchMedia` to `matches: true` for every query — don't gate
  layout on `matchMedia` (use `viewport.clientWidth`).
- List view (`#feature-list`) is the keyboard/screen-reader fallback; keep it
  rendering every entry.
