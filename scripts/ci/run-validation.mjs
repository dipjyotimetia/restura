#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, statePath, treeSignature } from '../../.codex/hooks/_shared.mjs';

const root = repoRoot(process.cwd());
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'validate:checks'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
const passed = result.status === 0;

try {
  const tree = treeSignature(root);
  const stateFile = statePath('stop-checks.json', root);
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({ signature: tree.signature, passed, checkedAt: new Date().toISOString() })
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Unable to record validation evidence: ${message.slice(0, 500)}\n`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) process.exitCode = result.status ?? 1;
