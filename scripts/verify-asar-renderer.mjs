// Verify the packaged Electron app actually bundles the renderer entry point.
// Guards against dist/web layout / files-glob drift that would otherwise ship
// an app that launches to a blank window. Uses @electron/asar (already a
// transitive dep of electron-builder) — no extra dependencies.
//
// Usage: node scripts/verify-asar-renderer.mjs <path-to-app.asar>
import asar from '@electron/asar';

const asarPath = process.argv[2];
if (!asarPath) {
  console.error('::error::usage: verify-asar-renderer.mjs <app.asar>');
  process.exit(1);
}

// listPackage returns OS-separator paths — backslashes on Windows — so
// normalize to forward slashes before matching (the check was Windows-broken).
const files = asar.listPackage(asarPath, { isPack: false }).map((f) => f.replace(/\\/g, '/'));

if (!files.includes('/dist/web/index.html')) {
  console.error('::error::renderer (dist/web/index.html) missing from app.asar');
  process.exit(1);
}

console.log('OK: renderer bundled at dist/web/index.html');
