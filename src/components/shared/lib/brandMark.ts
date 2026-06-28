import markData from './brandMark.json';

/**
 * Canonical Restura brand mark — a constructed "R" with a squared,
 * rounded-corner bowl.
 *
 * The mark is a constructed letterform (not a typeface glyph): a vertical stem,
 * an engineered squared bowl, and a leg that springs cleanly from the stem/bowl
 * junction. It is drawn as flat-colour strokes so the *same* geometry serves the
 * favicon, the in-app sidebar mark, the macOS menu-bar template, and the
 * rasterised app icon — defined by silhouette, not by colour, and legible down
 * to 16px (no leg-tip ornament to collapse into a blob at favicon size).
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
 * Fields: `viewBox` (authoring square), `strokeWidth`, `paths` ([stem, bowl,
 * leg]), `gradient` ({from, to}), `tileRadiusRatio` (iOS-style corner fraction).
 */
export const BRAND_MARK = markData;
