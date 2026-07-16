#!/usr/bin/env node
import { extractToolPaths, readPayload, repoRoot } from './_shared.mjs';

const generated = new Map([
  [
    'src/lib/opencollection/spec-types.ts',
    'Edit vendor/opencollection/v1.0.0/schema.json, then run `npm run gen:opencollection-types`.',
  ],
  [
    'docs/CAPABILITY_MATRIX.md',
    'Edit src/lib/shared/capabilities.ts, then run `npm run capabilities:matrix`.',
  ],
]);

try {
  const payload = readPayload();
  const root = repoRoot(payload?.cwd || process.cwd());
  for (const file of extractToolPaths(payload?.tool_input, root)) {
    const guidance =
      generated.get(file) ??
      (file.endsWith('.generated.ts')
        ? 'Regenerate it with its owning build script instead of editing it by hand.'
        : null);
    if (!guidance) continue;
    process.stderr.write(`Blocked generated-file edit: ${file}. ${guidance}\n`);
    process.exit(2);
  }
} catch {
  // Fail open on hook defects; deterministic repository gates still catch drift.
}

process.exit(0);
