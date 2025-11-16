#!/usr/bin/env node
/**
 * Icon Generation Script for Electron
 * Generates platform-specific icons from the SVG source
 *
 * Requirements:
 * - sharp (npm install sharp)
 * - png-to-ico (npm install png-to-ico)
 *
 * For macOS .icns files, you need iconutil (macOS only) or png2icns
 */

const fs = require('fs');
const path = require('path');

async function generateIcons() {
  const resourcesDir = path.join(__dirname, '../electron/resources');
  const svgPath = path.join(resourcesDir, 'icon.svg');

  if (!fs.existsSync(svgPath)) {
    console.error('SVG icon not found at:', svgPath);
    process.exit(1);
  }

  console.log('Generating icons from SVG...');

  // Try to use sharp for PNG generation
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('sharp not installed. Run: npm install sharp --save-dev');
    console.log('Skipping PNG generation...');
    return;
  }

  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  const iconsDir = path.join(resourcesDir, 'icons');

  // Create icons directory for Linux
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  // Generate PNGs for different sizes
  console.log('Generating PNG icons...');
  for (const size of sizes) {
    const outputPath = path.join(iconsDir, `${size}x${size}.png`);
    await sharp(svgPath)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`  Created ${size}x${size}.png`);
  }

  // Generate main icon.png (512x512)
  const mainIconPath = path.join(resourcesDir, 'icon.png');
  await sharp(svgPath)
    .resize(512, 512)
    .png()
    .toFile(mainIconPath);
  console.log('  Created icon.png (512x512)');

  // Generate ICO for Windows
  console.log('Generating Windows ICO...');
  try {
    const pngToIco = require('png-to-ico');
    const pngSizes = [16, 32, 48, 256].map(size =>
      path.join(iconsDir, `${size}x${size}.png`)
    );
    const icoBuffer = await pngToIco(pngSizes);
    fs.writeFileSync(path.join(resourcesDir, 'icon.ico'), icoBuffer);
    console.log('  Created icon.ico');
  } catch (err) {
    console.log('  Skipping ICO generation (install png-to-ico for Windows support)');
  }

  // Generate ICNS for macOS
  console.log('Generating macOS ICNS...');
  if (process.platform === 'darwin') {
    const { execSync } = require('child_process');
    const iconsetDir = path.join(resourcesDir, 'icon.iconset');

    if (!fs.existsSync(iconsetDir)) {
      fs.mkdirSync(iconsetDir);
    }

    // macOS iconset requires specific naming
    const iconsetSizes = [
      { size: 16, scale: 1 },
      { size: 16, scale: 2 },
      { size: 32, scale: 1 },
      { size: 32, scale: 2 },
      { size: 128, scale: 1 },
      { size: 128, scale: 2 },
      { size: 256, scale: 1 },
      { size: 256, scale: 2 },
      { size: 512, scale: 1 },
      { size: 512, scale: 2 },
    ];

    for (const { size, scale } of iconsetSizes) {
      const pixelSize = size * scale;
      const suffix = scale === 2 ? '@2x' : '';
      const filename = `icon_${size}x${size}${suffix}.png`;
      await sharp(svgPath)
        .resize(pixelSize, pixelSize)
        .png()
        .toFile(path.join(iconsetDir, filename));
    }

    try {
      execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(resourcesDir, 'icon.icns')}"`);
      console.log('  Created icon.icns');
      // Clean up iconset directory
      fs.rmSync(iconsetDir, { recursive: true });
    } catch {
      console.log('  Failed to create ICNS (iconutil not available)');
    }
  } else {
    console.log('  Skipping ICNS generation (macOS only)');
  }

  console.log('\nIcon generation complete!');
}

generateIcons().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
