#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { readPayload, repoRoot, statePath } from './_shared.mjs';

try {
  const payload = readPayload();
  const root = repoRoot(payload?.cwd || process.cwd());
  const directory = path.dirname(statePath('compaction.log', root));
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    path.resolve(directory, 'compaction.log'),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      trigger: String(payload?.trigger || 'unknown').slice(0, 32),
      sessionId: String(payload?.session_id || 'unknown').slice(0, 128),
    })}\n`
  );
} catch {
  // Metrics are advisory and must never block compaction.
}

process.exit(0);
