#!/usr/bin/env node
// Stop hook — reminds to update the docs-site after a "major" change.
//
// Nothing in `npm run validate` or the pre-commit hook checks docs-vs-code
// parity, and `docs-site/` is a separate, non-gated package — so user-facing
// docs drift silently after a feature/protocol/security/ADR change. This hook
// watches the branch's changed files: if a major surface changed but no
// `docs-site/` file did, it surfaces a one-time, NON-BLOCKING reminder to run
// `/docs-sync`. It never blocks the stop and de-dupes per change-set so it
// nags at most once until either docs-site is touched or new major changes land.
//
// Contract: never throw, always exit 0. On any error it stays silent.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Surfaces whose changes typically require a docs-site update (see the ownership
// map in .claude/skills/restura-production-checks/references/docs-parity.md).
const MAJOR_PREFIXES = [
  'src/features/',
  'shared/protocol/',
  'electron/main/',
  'worker/',
  'docs/adr/',
];
const MAJOR_FILES = new Set(['src/lib/shared/capabilities.ts']);

function isMajor(path) {
  return MAJOR_PREFIXES.some((p) => path.startsWith(p)) || MAJOR_FILES.has(path);
}

try {
  // Read (and ignore) the hook payload so stdin is drained.
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

  // Base = merge-base with the default branch, so committed branch work counts
  // (not just the uncommitted tree). Fall back gracefully.
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
  // Working tree (staged + unstaged). Parse porcelain, handling renames.
  for (const line of git('status --porcelain').split('\n')) {
    if (!line) continue;
    const rest = line.slice(3);
    const name = rest.includes(' -> ') ? rest.split(' -> ').pop() : rest;
    if (name) changed.add(name.trim().replace(/^"|"$/g, ''));
  }

  if (changed.size === 0) process.exit(0);

  const major = [...changed].filter(isMajor).sort();
  const touchedDocsSite = [...changed].some((f) => f.startsWith('docs-site/'));
  if (major.length === 0 || touchedDocsSite) process.exit(0);

  // De-dupe: remind once per distinct major change-set. Marker lives inside
  // .git (never committed). Re-reminds only when the major set changes.
  const hash = createHash('sha1').update(major.join('\n')).digest('hex');
  const markerPath = join(cwd, '.git', 'restura-docs-site-reminder');
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

  const sample = major.slice(0, 4).join(', ') + (major.length > 4 ? ', …' : '');
  const message =
    `📝 docs-site reminder: this branch changed a major surface (${sample}) ` +
    `but nothing under docs-site/. User-facing docs aren't gated by CI — ` +
    `run /docs-sync to update the guide/ADR/capability pages, or confirm none are stale.`;

  // Non-blocking: surface a warning to the user; do NOT force continuation.
  process.stdout.write(JSON.stringify({ systemMessage: message }));
} catch {
  // intentionally empty — a reminder hook must never break the session
}

process.exit(0);
