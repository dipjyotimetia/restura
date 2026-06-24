#!/usr/bin/env node
// Stop hook — reminds to keep AGENTS.md in sync with CLAUDE.md.
//
// CLAUDE.md (Claude Code guidance) and AGENTS.md (Codex guidance) document the
// same architecture for two different agent runtimes. CLAUDE.md is the actively
// maintained one; AGENTS.md drifts silently because nothing gates the two
// against each other. This hook watches the branch's changed files: if CLAUDE.md
// changed but AGENTS.md did not, it surfaces a one-time, NON-BLOCKING reminder to
// mirror the change. It de-dupes per change-set so it nags at most once until
// either AGENTS.md is touched or CLAUDE.md changes again.
//
// Mirrors docs-site-reminder.mjs. Contract: never throw, always exit 0.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

  // Only the primary direction: CLAUDE.md changed but AGENTS.md did not. (The
  // reverse is rarer and AGENTS.md is the follower, not the source of truth.)
  if (!changed.has('CLAUDE.md') || changed.has('AGENTS.md')) process.exit(0);

  // De-dupe: remind once per distinct change-set that includes CLAUDE.md.
  // Marker lives inside .git (never committed).
  const hash = createHash('sha1')
    .update([...changed].sort().join('\n'))
    .digest('hex');
  const markerPath = join(cwd, '.git', 'restura-agents-md-drift-reminder');
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

  const message =
    `📝 agent-docs reminder: this branch changed CLAUDE.md but not AGENTS.md. ` +
    `The two agent-guidance files document the same architecture for Claude Code ` +
    `vs. Codex — mirror the relevant change into AGENTS.md (keeping its ` +
    `Codex-targeted framing), or confirm it doesn't apply there.`;

  // Non-blocking: surface a warning to the user; do NOT force continuation.
  process.stdout.write(JSON.stringify({ systemMessage: message }));
} catch {
  // intentionally empty — a reminder hook must never break the session
}

process.exit(0);
