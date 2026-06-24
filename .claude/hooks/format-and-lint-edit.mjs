#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) — format and lint the file Claude just
// edited, so the working tree always matches `npm run format:check` / `npm run
// lint` and the pre-commit lint-staged pass has nothing left to do.
//
// Order mirrors .husky lint-staged (`eslint --fix` then `prettier --write`) so
// Prettier has the final say on formatting. ESLint runs only for code files
// under the same roots `npm run lint` covers (so we never trip "file ignored
// because outside config"). Any problems `--fix` can't resolve are surfaced
// back to Claude as additionalContext so it fixes them in the same turn instead
// of discovering them at CI time.
//
// Contract: never throw, always exit 0. Formatting is best-effort; the only
// thing this hook ever emits on stdout is a JSON additionalContext payload when
// ESLint reports unfixable problems.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

// Roots `npm run lint` covers — keep in sync with the `lint` script in package.json.
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

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const file = payload?.tool_input?.file_path;
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!file) process.exit(0);

  const rel = path.relative(cwd, file);
  // Only touch files inside the project (skip /tmp scratch, absolute escapes).
  if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);

  // Prefer the local binaries (fast); fall back to npx --no-install.
  const localBin = (name) => {
    const p = path.join(cwd, 'node_modules', '.bin', name);
    return existsSync(p) ? { cmd: p, pre: [] } : { cmd: 'npx', pre: ['--no-install', name] };
  };
  const run = (name, args) => {
    const { cmd, pre } = localBin(name);
    return execFileSync(cmd, [...pre, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  };

  const isCode = CODE_EXT.test(file);
  const underLintRoot = LINT_ROOTS.some((r) => rel.startsWith(r));

  // 1) ESLint --fix (code files in the linted roots only). Capture any problems
  //    that remain after autofix so we can hand them to Claude.
  let lintFeedback = '';
  if (isCode && underLintRoot) {
    try {
      run('eslint', ['--fix', file]);
    } catch (e) {
      const out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim();
      if (out) lintFeedback = out.slice(0, 2000);
    }
  }

  // 2) Prettier --write last, so formatting wins. --ignore-unknown makes it a
  //    no-op on unsupported extensions and it respects .prettierignore.
  try {
    run('prettier', ['--write', '--ignore-unknown', file]);
  } catch {
    // best-effort formatting
  }

  if (lintFeedback) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `ESLint reported problems in ${rel} that --fix could not resolve:\n` +
            `${lintFeedback}\n` +
            `Please fix these before moving on — they will fail \`npm run lint\` in CI.`,
        },
      })
    );
  }
} catch {
  // intentionally empty — a formatter hook must never break the session
}

process.exit(0);
