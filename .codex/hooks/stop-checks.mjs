#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitPath, readPayload, repoRoot, treeSignature } from './_shared.mjs';
import { validationDecision } from './stop-policy.mjs';

try {
  const payload = readPayload();
  const root = repoRoot(payload?.cwd || process.cwd());
  const tree = treeSignature(root);
  if (!tree.dirty) process.exit(0);

  const stateFile = gitPath('codex-hooks/stop-checks.json', root);
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    // No prior result for this worktree.
  }
  if (previous?.signature === tree.signature) process.exit(0);

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'validate'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 600_000,
  });
  const passed = result.status === 0;
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({ signature: tree.signature, passed, checkedAt: new Date().toISOString() })
  );

  const decision = validationDecision({ ...tree, previous, passed });
  if (!decision) process.exit(0);

  const diagnostics = `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-4000);
  if (diagnostics) process.stderr.write(`${diagnostics}\n`);
  process.stdout.write(JSON.stringify(decision));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Codex stop validation hook failed open: ${message.slice(0, 500)}\n`);
}

process.exit(0);
