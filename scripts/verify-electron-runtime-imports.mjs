import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'dist/electron');
const invalidElectronImport = /require\(["'](?:\.\.\/)+electron(?:\/[^"']*)?["']\)/;

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return javascriptFiles(absolute);
      return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
    })
  );
  return nested.flat();
}

const files = await javascriptFiles(root);
const invalid = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (invalidElectronImport.test(source)) invalid.push(path.relative(process.cwd(), file));
}

if (invalid.length > 0) {
  console.error(
    `Electron runtime imports were rewritten to local paths:\n${invalid.map((file) => `- ${file}`).join('\n')}`
  );
  process.exitCode = 1;
} else {
  console.log(`Verified Electron runtime imports in ${files.length} compiled files.`);
}
