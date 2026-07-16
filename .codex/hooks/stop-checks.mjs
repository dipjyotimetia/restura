#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readPayload, repoRoot, statePath, treeSignature } from './_shared.mjs';
import { validationDecision } from './stop-policy.mjs';

try {
  const payload = readPayload();
  const root = repoRoot(payload?.cwd || process.cwd());
  const tree = treeSignature(root);
  if (!tree.dirty) process.exit(0);

  const stateFile = statePath('stop-checks.json', root);
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    // No prior result for this worktree.
  }
  const decision = validationDecision({ ...tree, previous });
  if (!decision) process.exit(0);
  process.stdout.write(JSON.stringify(decision));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    JSON.stringify({
      continue: false,
      stopReason: `Restura validation evidence could not be verified: ${message.slice(0, 500)}`,
    })
  );
}

process.exit(0);
