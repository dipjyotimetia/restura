#!/usr/bin/env node
// Ratchet for Biome findings below error level. Warnings never fail `biome ci`,
// so without this the backlog in biome.json can only grow. Counts per rule may
// only go down: `--update` lowers the baseline and refuses to raise it.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE_PATH = fileURLToPath(new URL('./biome-ratchet.json', import.meta.url));

export function countByRule(diagnostics) {
  const counts = {};
  for (const { category, severity } of diagnostics) {
    if (severity === 'error') continue;
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function compareToBaseline(counts, baseline) {
  const regressions = [];
  const improvements = [];
  for (const rule of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const current = counts[rule] ?? 0;
    const allowed = baseline[rule] ?? 0;
    if (current > allowed) regressions.push({ rule, current, allowed });
    else if (current < allowed) improvements.push({ rule, current, allowed });
  }
  return { regressions, improvements };
}

function lintDiagnostics() {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@biomejs/biome/package.json');
  const bin = join(dirname(pkg), 'bin', 'biome');
  const result = spawnSync(
    process.execPath,
    [bin, 'lint', '.', '--reporter=json', '--max-diagnostics=none', '--colors=off'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const start = result.stdout.indexOf('{');
  if (start === -1) throw new Error(`biome produced no JSON report:\n${result.stderr}`);
  return JSON.parse(result.stdout.slice(start)).diagnostics;
}

function main() {
  const counts = countByRule(lintDiagnostics());
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const { regressions, improvements } = compareToBaseline(counts, baseline);

  if (regressions.length > 0) {
    console.error(
      'Biome ratchet: warnings increased. Fix them or run `npx biome lint .` to see where.'
    );
    for (const { rule, current, allowed } of regressions) {
      console.error(`  ${rule}: ${current} (allowed ${allowed})`);
    }
    process.exit(1);
  }

  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`Biome ratchet: baseline lowered for ${improvements.length} rule(s).`);
    return;
  }

  if (improvements.length > 0) {
    console.error(
      'Biome ratchet: warnings decreased. Lock it in with `npm run lint:ratchet -- --update`.'
    );
    for (const { rule, current, allowed } of improvements) {
      console.error(`  ${rule}: ${current} (baseline ${allowed})`);
    }
    process.exit(1);
  }
  console.log('Biome ratchet: within baseline.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
