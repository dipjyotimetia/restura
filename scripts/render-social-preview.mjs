// Renders scripts/social-preview.html -> social-preview.png at 1280x640.
// Uses Chromium (Playwright) for correct color-emoji rendering.
// Renders at 2x then downsamples to 1280x640 for supersampled crispness.
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const htmlPath = resolve(here, 'social-preview.html');
const outPath = resolve(root, 'social-preview.png');

if (!existsSync(htmlPath)) {
  console.error(`Missing ${htmlPath}`);
  process.exit(1);
}

const W = 1280;
const H = 640;
const SCALE = 2; // supersample

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: SCALE,
});
await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
// Ensure emoji fonts are fully loaded + laid out.
// eslint-disable-next-line no-undef -- this callback executes in the browser page context
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(150);

const tmpPath = resolve(root, '.social-preview-2x.png');
await page.screenshot({
  path: tmpPath,
  type: 'png',
  clip: { x: 0, y: 0, width: W, height: H },
  omitBackground: false,
});
await browser.close();

// Downsample 2x -> 1x with Lanczos + light sharpen for crisp text.
const { spawnSync } = await import('node:child_process');
const magick = spawnSync(
  'magick',
  [tmpPath, '-filter', 'Lanczos', '-resize', `${W}x${H}`, '-unsharp', '0x0.7+0.25+0', outPath],
  { stdio: 'inherit' }
);

if (magick.status !== 0) {
  console.error('ImageMagick downsample failed');
  process.exit(magick.status ?? 1);
}

const { rmSync } = await import('node:fs');
rmSync(tmpPath, { force: true });
console.log(`Wrote ${outPath} (${W}x${H})`);
