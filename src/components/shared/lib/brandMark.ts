import markData from './brandMark.json';

/**
 * Canonical Restura brand mark — a routing-monogram "R".
 *
 * The mark is a constructed letterform where the geometry doubles as the
 * product idea: the bowl reads as an out-and-back route, and the leg is an
 * outbound request that lands on a single endpoint {@link node} ("request
 * lands here"). It is drawn as `currentColor` strokes so the *same* geometry
 * serves the favicon, the in-app sidebar mark, the macOS menu-bar template,
 * and the rasterised app icon — defined by silhouette, not by colour.
 *
 * This module (backed by `brandMark.json`) is the SINGLE SOURCE OF TRUTH for
 * the geometry. `Logo.tsx` renders these values as JSX; `scripts/generate-icons.js`
 * reads the same JSON to stamp out every static SVG and raster derivative. Do
 * not re-type the path data anywhere else — change it here only.
 *
 * The `gradient` is the fixed brand fill (single-hue cobalt, tonal depth —
 * `oklch(60% 0.19 255)` → `oklch(72% 0.17 255)`). The brand mark is locked to
 * this gradient and does NOT follow the user's `--sp-accent` preset, so it
 * matches the favicon / app icon / OG card everywhere.
 *
 * Fields: `viewBox` (authoring square), `strokeWidth`, `paths` ([stem, bowl
 * (route), leg (request)]), `node` (leg endpoint), `gradient` ({from, to}),
 * `tileRadiusRatio` (iOS-style corner fraction).
 */
export const BRAND_MARK = markData;
