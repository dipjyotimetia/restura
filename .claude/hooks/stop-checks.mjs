#!/usr/bin/env node
// Stop hook — all end-of-turn checks, driven by ONE shared git changed-set.
//
// Consolidates what were three separate Stop hooks (docs-site reminder,
// AGENTS.md drift, type-check reminder) plus the per-edit ESLint pass. Computing
// the branch diff once and linting once per turn — instead of re-running git in
// three processes and booting ESLint on every edit — removes the duplicated
// work the old layout paid on every turn.
//
// Each concern keeps its own .git dedup marker so it nags independently and at
// most once per distinct change. Contract: never throws, always exits 0; output
// is a single blocking Stop decision with a reason (or nothing).

import { execFileSync } from 'node:child_process';
import { binPath, changedFiles, firstTimeFor, projectDir, readPayload } from './_shared.mjs';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const cwd = projectDir();

// --- docs-site parity: a major surface changed but docs-site/ didn't ---
const MAJOR_PREFIXES = [
  'src/features/',
  'shared/protocol/',
  'electron/main/',
  'worker/',
  'docs/adr/',
];
const MAJOR_FILES = new Set(['src/lib/shared/capabilities.ts']);
const isMajor = (p) => MAJOR_PREFIXES.some((x) => p.startsWith(x)) || MAJOR_FILES.has(p);

function docsSiteMessage(all) {
  const major = [...all].filter(isMajor).sort();
  if (major.length === 0) return null;
  if ([...all].some((f) => f.startsWith('docs-site/'))) return null;
  if (!firstTimeFor('restura-docs-site-reminder', major.join('\n'), cwd)) return null;
  const sample = major.slice(0, 4).join(', ') + (major.length > 4 ? ', …' : '');
  return (
    `📝 docs-site reminder: this branch changed a major surface (${sample}) ` +
    `but nothing under docs-site/. User-facing docs aren't gated by CI — ` +
    `run /docs-sync to update the guide/ADR/capability pages, or confirm none are stale.`
  );
}

// --- AGENTS.md drift: CLAUDE.md changed but AGENTS.md didn't ---
function agentsMdMessage(all) {
  if (!all.has('CLAUDE.md') || all.has('AGENTS.md')) return null;
  if (!firstTimeFor('restura-agents-md-drift-reminder', [...all].sort().join('\n'), cwd))
    return null;
  return (
    `📝 agent-docs reminder: this branch changed CLAUDE.md but not AGENTS.md. ` +
    `The two agent-guidance files document the same architecture for Claude Code ` +
    `vs. Codex — mirror the relevant change into AGENTS.md (keeping its ` +
    `Codex-targeted framing), or confirm it doesn't apply there.`
  );
}

// --- type-check reminder: typed source changed (plain type-check is renderer-only) ---
const TS_ROOTS = ['src/', 'shared/', 'electron/', 'worker/', 'cli/', 'echo/', 'echo-local/'];
const isTypedSource = (p) => /\.(ts|tsx|mts|cts)$/.test(p) && TS_ROOTS.some((r) => p.startsWith(r));

function typeCheckMessage(all) {
  const typed = [...all].filter(isTypedSource).sort();
  if (typed.length === 0) return null;
  if (!firstTimeFor('restura-type-check-reminder', typed.join('\n'), cwd)) return null;
  const nonRenderer = typed.some((p) => !p.startsWith('src/'));
  const detail = nonRenderer
    ? 'including non-renderer code that plain `type-check` does NOT cover'
    : 'and the pre-commit hook does not run tsc';
  return (
    `🔎 type-check reminder: this branch changed TypeScript source (${detail}). ` +
    `Run \`npm run type-check:all\` before committing — plain \`type-check\` is renderer-only.`
  );
}

// --- lint: run ESLint ONCE over the working-tree code files, surface problems ---
const LINT_ROOTS = [
  'src/',
  'shared/',
  'electron/main/',
  'worker/',
  'echo/',
  'echo-local/',
  'cli/',
  'tests/',
  'scripts/',
];
const CODE_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

function lintMessage(working) {
  const files = [...working].filter(
    (f) => CODE_EXT.test(f) && LINT_ROOTS.some((r) => f.startsWith(r)) && existsSync(join(cwd, f))
  );
  if (files.length === 0) return null;
  const eslint = binPath('eslint', cwd);
  if (!eslint) return null;

  // Skip the (~1s) ESLint boot entirely when no candidate file changed since the
  // last lint. The signature is the file set + their mtimes; if it's unchanged
  // we've already linted this exact state, so there's nothing new to report.
  const sig = files
    .map((f) => {
      try {
        return `${f}:${statSync(join(cwd, f)).mtimeMs}`;
      } catch {
        return f;
      }
    })
    .sort()
    .join('|');
  if (!firstTimeFor('restura-lint-stop', sig, cwd)) return null;

  let out = '';
  try {
    // Report-only (no --fix): formatting was already applied per-edit by
    // Prettier, and lint-staged runs --fix at commit. --cache speeds re-runs.
    execFileSync(
      eslint,
      [
        '--cache',
        '--cache-location',
        join(cwd, 'node_modules', '.cache', 'eslint-stop-hook'),
        ...files,
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return null; // clean
  } catch (e) {
    out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim();
  }
  if (!out) return null;
  return (
    `⚠️ ESLint found problems in changed files (\`npm run lint\` will fail in CI; ` +
    `\`npm run lint:fix\` auto-fixes most):\n${out.slice(0, 2000)}`
  );
}

try {
  readPayload(); // drain stdin
  const { all, working } = changedFiles(cwd);
  if (all.size === 0) process.exit(0);

  const messages = [
    docsSiteMessage(all),
    agentsMdMessage(all),
    typeCheckMessage(all),
    lintMessage(working),
  ].filter(Boolean);

  if (messages.length) {
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: messages.join('\n\n') })
    );
  }
} catch {
  // intentionally empty — a checks hook must never break the session
}

process.exit(0);
