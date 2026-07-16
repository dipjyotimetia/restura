#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractToolPaths, readPayload, repoRoot, statePath } from './_shared.mjs';

try {
  const payload = readPayload();
  const root = repoRoot(payload?.cwd || process.cwd());
  const files = extractToolPaths(payload?.tool_input, root);
  if (files.length === 0) process.exit(0);
  const stateFile = statePath('edited-files.json', root);
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ files, recordedAt: new Date().toISOString() }));
} catch {
  // Advisory edit tracking must not break the agent loop.
}

process.exit(0);
