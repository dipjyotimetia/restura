#!/usr/bin/env node
// Stop hook — reminds to run `npm run type-check:all` when TypeScript source changed.
//
// Two gaps make type errors easy to ship: (1) the pre-commit hook runs only
// lint-staged (eslint + prettier), never `tsc`; (2) plain `npm run type-check`
// covers ONLY the renderer — the Worker, Electron main, and CLI are separate
// tsc projects. So a branch can touch worker/ or electron/main/ and commit with
// type errors that nothing local catches until CI. This hook watches the
// branch's changed files: if any typed source changed, it surfaces a one-time,
// NON-BLOCKING reminder to run `type-check:all` (it does NOT run tsc itself —
// too slow for a Stop hook). De-dupes per change-set so it nags at most once.
//
// Mirrors docs-site-reminder.mjs. Contract: never throw, always exit 0.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Typed-project roots whose .ts/.tsx the renderer-only `type-check` may miss.
const TS_ROOTS = ['src/', 'shared/', 'electron/', 'worker/', 'cli/', 'echo/', 'echo-local/'];
const isTypedSource = (p) => /\.(ts|tsx|mts|cts)$/.test(p) && TS_ROOTS.some((r) => p.startsWith(r));

try {
  try {
    readFileSync(0, 'utf8');
  } catch {
    // no stdin — fine
  }

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const git = (cmd) =>
    execSync(`git ${cmd}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();

  let base = '';
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      base = git(`merge-base HEAD ${ref}`);
      if (base) break;
    } catch {
      // try next ref
    }
  }

  const changed = new Set();
  if (base) {
    for (const f of git(`diff --name-only ${base} HEAD`).split('\n')) {
      if (f) changed.add(f);
    }
  }
  for (const line of git('status --porcelain').split('\n')) {
    if (!line) continue;
    const rest = line.slice(3);
    const name = rest.includes(' -> ') ? rest.split(' -> ').pop() : rest;
    if (name) changed.add(name.trim().replace(/^"|"$/g, ''));
  }

  const typed = [...changed].filter(isTypedSource).sort();
  if (typed.length === 0) process.exit(0);

  // De-dupe per distinct typed-source change-set. Marker lives inside .git.
  const hash = createHash('sha1').update(typed.join('\n')).digest('hex');
  const markerPath = join(cwd, '.git', 'restura-type-check-reminder');
  let last = '';
  try {
    last = readFileSync(markerPath, 'utf8').trim();
  } catch {
    // no marker yet
  }
  if (last === hash) process.exit(0);
  try {
    writeFileSync(markerPath, hash);
  } catch {
    // best-effort; still remind
  }

  const nonRenderer = typed.some((p) => !p.startsWith('src/'));
  const detail = nonRenderer
    ? `including non-renderer code that plain \`type-check\` does NOT cover`
    : `and the pre-commit hook does not run tsc`;
  const message =
    `🔎 type-check reminder: this branch changed TypeScript source (${detail}). ` +
    `Run \`npm run type-check:all\` before committing — plain \`type-check\` is renderer-only.`;

  process.stdout.write(JSON.stringify({ systemMessage: message }));
} catch {
  // intentionally empty — a reminder hook must never break the session
}

process.exit(0);
