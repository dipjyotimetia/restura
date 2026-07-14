/**
 * Vite plugin that generates `sandboxLibraries/bundle.generated.ts` at
 * `buildStart` (dev-server start and `vite build`) when it's missing.
 * Delegates to the standalone Node script `scripts/build-sandbox-libs.mjs`,
 * which is the authoritative regen path (`npm run build:sandbox-libs`) and
 * is also reused by the CLI's prebuild — same bundling logic everywhere.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts/build-sandbox-libs.mjs');
const outFile = path.join(
  repoRoot,
  'src/features/scripts/lib/sandboxLibraries/bundle.generated.ts'
);

function runBuild(reason: string): void {
  if (!existsSync(scriptPath)) {
    throw new Error(`[vite-plugin-sandbox-libs] missing ${scriptPath}`);
  }
  console.log(`[sandbox-libs] regenerating (${reason})...`);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `[vite-plugin-sandbox-libs] build-sandbox-libs.mjs exited with ${result.status}`
    );
  }
}

export function sandboxLibsPlugin(): Plugin {
  return {
    name: 'sandbox-libs',
    enforce: 'pre',
    buildStart() {
      // Only re-bundle if the generated file is missing — the standalone
      // npm script (`npm run build:sandbox-libs`) is the authoritative
      // regen path. This keeps Vite startup fast on incremental dev runs.
      if (!existsSync(outFile)) {
        runBuild('first-time build');
      }
    },
  };
}
