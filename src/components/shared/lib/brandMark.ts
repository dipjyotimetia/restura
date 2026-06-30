import markData from './brandMark.json';

/**
 * Canonical Restura brand mark — the "Routing R".
 *
 * A bold geometric R whose diagonal leg lands on a {@link node}, reading as an
 * endpoint on a route (a nod to the multi-protocol routing the app does). It is
 * drawn as flat strokes on a 96-unit authoring square, so the *same* geometry
 * serves the favicon, the in-app `Logo`, the macOS menu-bar template, and every
 * rasterised app-icon derivative — defined by silhouette, not by colour.
 *
 * This module (backed by `brandMark.json`) is the SINGLE SOURCE OF TRUTH for the
 * geometry. `Logo.tsx` renders these values as JSX; `scripts/generate-icons.js`
 * reads the same JSON to stamp out every static SVG and raster derivative. Do
 * NOT re-type the path data anywhere else — change it here only, then re-run
 * `node scripts/generate-icons.js`.
 *
 * `gradient` is the fixed brand fill (single-hue cobalt, tonal depth). The mark
 * is locked to this gradient and intentionally does NOT follow the user's
 * `--sp-accent` preset, so it matches the favicon / app icon / OG card even when
 * the accent is changed.
 *
 * Fields: `viewBox` (authoring square), `strokeWidth`, `paths` ([stem, bowl,
 * leg]), `node` (leg endpoint), `gradient` ({from, to}), `tileRadiusRatio`
 * (corner fraction of the tile), `highlight` (subtle inner glass edge).
 */
export const BRAND_MARK = markData;
