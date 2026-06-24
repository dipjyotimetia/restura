#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit) — block hand-edits to generated files.
//
// Two CI gates diff generated artifacts and fail on any drift
// (`verify:opencollection-types`, `capabilities:check`). Hand-editing the
// output instead of the source is a recurring trap (see the
// restura-production-checks skill). This hook denies the edit and tells Claude
// which source to edit + how to regenerate, turning a future CI failure into an
// immediate course-correction.
//
// PreToolUse CAN block: exit code 2 prevents the tool call and feeds stderr back
// to Claude as the reason. On any internal error we exit 0 (fail open — never
// block on a hook bug).

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// relPath -> how to regenerate it.
const GENERATED_FILES = new Map([
  [
    'src/lib/opencollection/spec-types.ts',
    'Edit vendor/opencollection/.../schema.json, then run `npm run gen:opencollection-types`.',
  ],
  [
    'docs/CAPABILITY_MATRIX.md',
    'Edit src/lib/shared/capabilities.ts (the source of truth), then run `npm run capabilities:matrix`.',
  ],
]);

// Suffix patterns for generated files whose name encodes their status.
const GENERATED_SUFFIXES = [
  {
    suffix: '.generated.ts',
    how: 'Regenerate it via its build script rather than editing by hand.',
  },
];

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const file = payload?.tool_input?.file_path;
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!file) process.exit(0);

  const rel = path.relative(cwd, file).split(path.sep).join('/');

  let how = GENERATED_FILES.get(rel);
  if (!how) {
    const match = GENERATED_SUFFIXES.find((g) => rel.endsWith(g.suffix));
    if (match) how = match.how;
  }

  if (how) {
    process.stderr.write(
      `Blocked: ${rel} is a generated file — do not edit it by hand (a CI gate diffs it and ` +
        `will fail on any drift). ${how}`
    );
    process.exit(2); // block the edit, feed the reason to Claude
  }
} catch {
  // fail open — never block the session on a hook error
}

process.exit(0);
