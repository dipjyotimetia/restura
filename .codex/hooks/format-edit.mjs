#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractToolPaths, readPayload, repoRoot } from './_shared.mjs';

try {
  const payload = readPayload();
  const root = repoRoot(payload?.cwd || process.cwd());
  const files = extractToolPaths(payload?.tool_input, root)
    .map((file) => path.resolve(root, file))
    .filter((file) => existsSync(file));
  const biome = path.resolve(root, 'node_modules/.bin/biome');
  if (files.length > 0 && existsSync(biome)) {
    execFileSync(biome, ['format', '--write', '--no-errors-on-unmatched', ...files], {
      cwd: root,
      stdio: 'ignore',
    });
  }
} catch {
  // Best effort: formatting must not break the agent loop.
}

process.exit(0);
