#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) — format the edited file with Prettier so
// the working tree always matches `npm run format:check`.
//
// Per-edit work is kept to JUST Prettier (one file, ~200ms) to stay fast on the
// hot path. ESLint is NOT run here — booting it on every edit costs ~1s and
// re-lints the same file repeatedly. The Stop hook lints the whole changed set
// ONCE per turn instead. Best-effort: never throws, always exits 0, silent.

import { execFileSync } from 'node:child_process';
import { binPath, projectDir, projectRelative, readPayload } from './_shared.mjs';

try {
  const cwd = projectDir();
  const file = readPayload()?.tool_input?.file_path;
  if (!projectRelative(file, cwd)) process.exit(0); // outside the project — skip

  const prettier = binPath('prettier', cwd);
  if (prettier) {
    // --ignore-unknown makes this a no-op on unsupported extensions and it
    // respects .prettierignore.
    execFileSync(prettier, ['--write', '--ignore-unknown', file], { cwd, stdio: 'ignore' });
  }
} catch {
  // best-effort formatter — never break the session
}

process.exit(0);
