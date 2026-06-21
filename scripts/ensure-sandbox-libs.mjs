#!/usr/bin/env node
/**
 * Lightweight guard chained before tsc / vitest. The real bundle file
 * (`bundle.generated.ts`) is gitignored — Vite's plugin regenerates it
 * on dev/build, the CLI's prebuild regenerates it before tsup, and this
 * script handles the only remaining entrypoint: a fresh checkout running
 * `npm run type-check` (or CI's tsc step) before any Vite/CLI command
 * has executed.
 *
 * No-ops if the bundle is already present. Otherwise delegates to the
 * standalone bundler — which is the same script Vite / CLI invoke.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const target = path.join(repoRoot, 'src/features/scripts/lib/sandboxLibraries/bundle.generated.ts');

if (existsSync(target)) {
  // Fast path: already generated.
  process.exit(0);
}

console.log('[ensure-sandbox-libs] bundle.generated.ts missing — generating once...');
const result = spawnSync(
  process.execPath,
  [path.join(repoRoot, 'scripts/build-sandbox-libs.mjs')],
  { cwd: repoRoot, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
