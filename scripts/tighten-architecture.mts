// npm run architecture:tighten [-- --dry-run]
// Lowers the caps in architecture.config.mts to the code (never raises them).
// Logic and tests: scripts/architecture-tighten.mts, tests/architecture-tighten.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { architecturePolicy } from './architecture.config.mts';
import { scanArchitectureFiles } from './architecture-scanner.mts';
import { measure, tightenConfigSource } from './architecture-tighten.mts';

const dryRun = process.argv.includes('--dry-run');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'scripts', 'architecture.config.mts');
const input = measure(root, scanArchitectureFiles(root, architecturePolicy), architecturePolicy);
const { source, changes } = tightenConfigSource(fs.readFileSync(configPath, 'utf8'), input);

if (changes.length === 0) {
  console.log('Architecture caps already match the code.');
} else {
  for (const change of changes) console.log(`- ${change}`);
  if (dryRun) {
    console.log('(dry run: architecture.config.mts not written)');
  } else {
    fs.writeFileSync(configPath, source);
    console.log(`Tightened ${changes.length} cap(s) in scripts/architecture.config.mts.`);
  }
}
