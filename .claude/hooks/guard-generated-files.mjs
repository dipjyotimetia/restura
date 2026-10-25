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

import { projectDir, projectRelative, readPayload } from './_shared.mjs';

// relPath -> how to regenerate it.
const GENERATED_FILES = new Map([
  [
    // Output of scripts/gen-opencollection-types.mjs. (src/lib/opencollection/
    // spec-types.ts is a hand-written deprecated re-export shim — not guarded.)
    'shared/opencollection/spec-types.ts',
    'Edit vendor/opencollection/v1.0.0/schema.json, then run `npm run gen:opencollection-types`.',
  ],
  [
    'docs/CAPABILITY_MATRIX.md',
    'Edit the area module under src/lib/shared/capabilities/ (the source of truth), then run `npm run capabilities:matrix`.',
  ],
]);

// Directory prefixes whose contents are entirely generator output.
const GENERATED_PREFIXES = [
  {
    // buf.gen.yaml: protoc-gen-es output for e2e/mocks/proto/*.proto
    prefix: 'e2e/mocks/proto/gen/',
    how: 'Edit the .proto source under e2e/mocks/proto/, then run `npm run proto:gen`.',
  },
];

// Suffix patterns for generated files whose name encodes their status.
const GENERATED_SUFFIXES = [
  {
    suffix: '.generated.ts',
    how: 'Regenerate it via its build script rather than editing by hand.',
  },
];

try {
  const cwd = projectDir();
  const filePath = readPayload()?.tool_input?.file_path;

  // Vitest file snapshots: `*.snap` is gitignored, so a test that writes one
  // passes locally (snapshot created on first run) and fails in CI (missing).
  if (typeof filePath === 'string' && filePath.endsWith('.snap')) {
    process.stderr.write(
      `Blocked: ${filePath} is a snapshot file — use inline snapshots only ` +
        `(\`toMatchInlineSnapshot()\`) or explicit assertions. \`*.snap\` is gitignored, so it ` +
        `passes locally and fails in CI.`
    );
    process.exit(2);
  }

  const rel = projectRelative(filePath, cwd);
  if (!rel) process.exit(0); // no file / outside the project

  let how = GENERATED_FILES.get(rel);
  if (!how) how = GENERATED_PREFIXES.find((g) => rel.startsWith(g.prefix))?.how;
  if (!how) how = GENERATED_SUFFIXES.find((g) => rel.endsWith(g.suffix))?.how;

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
