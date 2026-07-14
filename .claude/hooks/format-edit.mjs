#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) — format the edited file with Biome so
// the working tree always matches `npm run format:check`.
//
// Per-edit work is kept to JUST Biome (one file, ~200ms) to stay fast on the
// hot path. Biome lint is NOT run here — checking on every edit costs ~1s and
// re-lints the same file repeatedly. The Stop hook lints the whole changed set
// ONCE per turn instead. Best-effort: never throws, always exits 0, silent.

import { execFileSync } from 'node:child_process';
import { binPath, projectDir, projectRelative, readPayload } from './_shared.mjs';

try {
  const cwd = projectDir();
  const file = readPayload()?.tool_input?.file_path;
  if (!projectRelative(file, cwd)) process.exit(0); // outside the project — skip

  const biome = binPath('biome', cwd);
  if (biome) {
    execFileSync(biome, ['format', '--write', '--no-errors-on-unmatched', file], {
      cwd,
      stdio: 'ignore',
    });
  }
} catch {
  // best-effort formatter — never break the session
}

process.exit(0);
