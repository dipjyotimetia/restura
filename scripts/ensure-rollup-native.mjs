#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const nativePackage = '@rollup/rollup-linux-x64-gnu';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  process.exit(0);
}

try {
  require.resolve(nativePackage);
  process.exit(0);
} catch {
  // Fall through and install the exact Rollup native binary that tsup expects.
}

const rollupPkgPath = require.resolve('rollup/package.json');
const rollupPkg = JSON.parse(await readFile(rollupPkgPath, 'utf8'));

console.log(
  `[ensure-rollup-native] ${nativePackage} missing — installing ${rollupPkg.version} once...`
);

const npmExecPath = process.env.npm_execpath;
const result = npmExecPath
  ? spawnSync(
      process.execPath,
      [
        npmExecPath,
        'install',
        '--no-save',
        '--no-package-lock',
        '--prefer-offline',
        '--no-audit',
        '--no-fund',
        `${nativePackage}@${rollupPkg.version}`,
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
      }
    )
  : spawnSync(
      'npm',
      [
        'install',
        '--no-save',
        '--no-package-lock',
        '--prefer-offline',
        '--no-audit',
        '--no-fund',
        `${nativePackage}@${rollupPkg.version}`,
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
      }
    );

process.exit(result.status ?? 1);
