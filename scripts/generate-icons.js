#!/usr/bin/env node
/**
 * Brand asset generator.
 *
 * Single source of truth = `src/components/shared/lib/brandMark.json` (the same
 * geometry `Logo.tsx` renders). This script STAMPS that geometry into every
 * static SVG and raster derivative so the favicon, app icon, docs favicon, and
 * macOS menu-bar template can never drift from each other or from the in-app mark.
 *
 * Outputs:
 *   electron/resources/icon.svg            512 app-icon master (tile + mark)
 *   electron/resources/icon.png            512 raster
 *   electron/resources/icons/<n>x<n>.png   Linux icon set
 *   electron/resources/icon.ico            Windows
 *   electron/resources/icon.icns           macOS (darwin only)
 *   electron/resources/trayIconTemplate.png (+@2x)  monochrome menu-bar template
 *   public/icon.svg                        favicon (tile + mark)
 *   public/icon-maskable.svg               full-bleed maskable PWA icon
 *   public/apple-touch-icon.png            180 iOS home-screen icon
 *   docs-site/public/favicon.svg           docs favicon (== public/icon.svg)
 *   extension/chrome/public/icons/icon-{16,48,128}.png  Chrome extension icons
 *
 * Requirements: sharp, png-to-ico. macOS .icns needs iconutil (macOS only).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const brand = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/components/shared/lib/brandMark.json'), 'utf8')
);
const VB = brand.viewBox;
const RX = Math.round(VB * brand.tileRadiusRatio * 100) / 100;

// --- SVG builders (geometry comes from brand, so it can't drift) -------------

/** The Routing-R strokes + endpoint node, in a single flat `color`. */
function markInner(color) {
  const strokes = brand.paths
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${brand.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join('');
  const n = brand.node;
  return `${strokes}<circle cx="${n.cx}" cy="${n.cy}" r="${n.r}" fill="${color}"/>`;
}

const gradientDef = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${brand.gradient.from}"/><stop offset="100%" stop-color="${brand.gradient.to}"/></linearGradient></defs>`;

/** Subtle inner glass edge — only on rounded tiles (skipped when full-bleed). */
function highlightRect(rx) {
  const h = brand.highlight;
  if (!h || rx <= 0) return '';
  return `<rect x="${h.inset}" y="${h.inset}" width="${VB - 2 * h.inset}" height="${VB - 2 * h.inset}" rx="${Math.max(rx - h.inset, 0)}" fill="none" stroke="rgba(255,255,255,${h.opacity})" stroke-width="${h.strokeWidth}"/>`;
}

/** Tile lockup: rounded gradient tile + white mark. `rx` 0 = full-bleed. */
function tileSvg(px, rx) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VB} ${VB}" role="img" aria-label="Restura">` +
    gradientDef +
    `<rect width="${VB}" height="${VB}" rx="${rx}" fill="url(#g)"/>` +
    highlightRect(rx) +
    markInner('#ffffff') +
    `</svg>`
  );
}

/** Bare mark on transparent ground, single flat `color` (menu-bar template). */
function bareSvg(px, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VB} ${VB}">${markInner(color)}</svg>`;
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents + '\n');
  console.log('  wrote', path.relative(ROOT, file));
}

async function generate() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('sharp not installed. Run: npm install sharp --save-dev');
    process.exit(1);
  }

  const resourcesDir = path.join(ROOT, 'electron/resources');
  const iconsDir = path.join(resourcesDir, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });

  // 1. Static SVGs (the brand sources) --------------------------------------
  console.log('Writing static SVGs from brandMark.json...');
  const masterSvgPath = path.join(resourcesDir, 'icon.svg');
  write(masterSvgPath, tileSvg(512, RX));
  write(path.join(ROOT, 'public/icon.svg'), tileSvg(32, RX));
  write(path.join(ROOT, 'docs-site/public/favicon.svg'), tileSvg(32, RX));
  // Maskable PWA icon: full-bleed gradient (OS applies its own mask); the mark
  // already sits inside the central safe zone (~22%-78% of the frame).
  write(path.join(ROOT, 'public/icon-maskable.svg'), tileSvg(512, 0));

  // 2. App-icon rasters (from the 512 master) -------------------------------
  console.log('Generating PNG icons...');
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    await sharp(masterSvgPath)
      .resize(size, size)
      .png()
      .toFile(path.join(iconsDir, `${size}x${size}.png`));
  }
  await sharp(masterSvgPath).resize(512, 512).png().toFile(path.join(resourcesDir, 'icon.png'));
  console.log('  created icon.png + icons/*.png');

  // Chrome extension icons: same tile+mark master, just its own size set/dir.
  const extensionIconsDir = path.join(ROOT, 'extension/chrome/public/icons');
  fs.mkdirSync(extensionIconsDir, { recursive: true });
  for (const size of [16, 48, 128]) {
    await sharp(masterSvgPath)
      .resize(size, size)
      .png()
      .toFile(path.join(extensionIconsDir, `icon-${size}.png`));
  }
  console.log('  created extension/chrome/public/icons/icon-*.png');

  // apple-touch-icon: full-bleed (iOS rounds it itself), no transparency.
  await sharp(Buffer.from(tileSvg(180, 0)))
    .resize(180, 180)
    .png()
    .toFile(path.join(ROOT, 'public/apple-touch-icon.png'));
  console.log('  created public/apple-touch-icon.png');

  // 3. macOS menu-bar template (monochrome black + alpha, transparent ground).
  //    @2x for retina; Electron picks the right scale when the basename matches.
  for (const px of [16, 32]) {
    const suffix = px === 32 ? '@2x' : '';
    await sharp(Buffer.from(bareSvg(px, '#000000')))
      .resize(px, px)
      .png()
      .toFile(path.join(resourcesDir, `trayIconTemplate${suffix}.png`));
  }
  console.log('  created trayIconTemplate.png (+@2x)');

  // 4. Windows ICO ----------------------------------------------------------
  console.log('Generating Windows ICO...');
  try {
    const pngToIcoMod = require('png-to-ico');
    const pngToIco = pngToIcoMod.default || pngToIcoMod;
    const pngSizes = [16, 32, 48, 256].map((s) => path.join(iconsDir, `${s}x${s}.png`));
    fs.writeFileSync(path.join(resourcesDir, 'icon.ico'), await pngToIco(pngSizes));
    console.log('  created icon.ico');
  } catch {
    console.log('  skipping ICO (install png-to-ico for Windows support)');
  }

  // 5. macOS ICNS -----------------------------------------------------------
  console.log('Generating macOS ICNS...');
  if (process.platform === 'darwin') {
    const { execSync } = require('child_process');
    const iconsetDir = path.join(resourcesDir, 'icon.iconset');
    fs.mkdirSync(iconsetDir, { recursive: true });
    const iconsetSizes = [16, 32, 128, 256, 512];
    for (const size of iconsetSizes) {
      for (const scale of [1, 2]) {
        const suffix = scale === 2 ? '@2x' : '';
        await sharp(masterSvgPath)
          .resize(size * scale, size * scale)
          .png()
          .toFile(path.join(iconsetDir, `icon_${size}x${size}${suffix}.png`));
      }
    }
    try {
      execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(resourcesDir, 'icon.icns')}"`);
      console.log('  created icon.icns');
      fs.rmSync(iconsetDir, { recursive: true });
    } catch {
      console.log('  failed to create ICNS (iconutil not available)');
    }
  } else {
    console.log('  skipping ICNS (macOS only)');
  }

  console.log('\nBrand assets generated.');
}

generate().catch((err) => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
