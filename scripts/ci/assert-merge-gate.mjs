#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_JOBS = [
  'validate',
  'self-host-smoke',
  'electron-smoke',
  'e2e',
  'e2e-extension',
  'e2e-electron',
  'vscode-extension-e2e',
  'docs',
];

export function evaluateMergeGate(needs, allowedSkipped) {
  const errors = [];
  for (const job of REQUIRED_JOBS) {
    const result = needs?.[job]?.result;
    if (result === 'success') continue;
    if (result === 'skipped' && allowedSkipped.has(job)) continue;
    errors.push(`${job}: ${result || 'missing'}`);
  }
  return { ok: errors.length === 0, errors };
}

function main() {
  let needs;
  try {
    needs = JSON.parse(process.env.NEEDS_JSON || '');
  } catch {
    process.stderr.write('merge-gate: NEEDS_JSON must be valid JSON\n');
    process.exitCode = 1;
    return;
  }
  const allowedSkipped = new Set(
    (process.env.ALLOWED_SKIPPED_JOBS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const evaluation = evaluateMergeGate(needs, allowedSkipped);
  if (!evaluation.ok) {
    for (const error of evaluation.errors) process.stderr.write(`merge-gate: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('merge-gate: all required jobs passed\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
