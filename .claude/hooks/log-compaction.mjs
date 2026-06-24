#!/usr/bin/env node
// PreCompact hook — records one line per context compaction to
// .claude/metrics/compaction.log so how often sessions hit the context limit is
// observable over time (a rising rate is a signal that CLAUDE.md / tool output /
// context is getting heavy and worth trimming). Pairs with log-skill-usage.mjs.
//
// Observability only: it NEVER blocks compaction (exit 2 would). Best-effort —
// never throws, always exits 0, emits nothing on stdout.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const logPath = join(projectDir, '.claude', 'metrics', 'compaction.log');
  const trigger = payload?.trigger ?? 'unknown'; // 'manual' | 'auto'
  const session = payload?.session_id ?? '-';
  const transcript = payload?.transcript_path ?? '-';
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${new Date().toISOString()}\t${trigger}\t${session}\t${transcript}\n`);
} catch {
  // intentionally empty — an observability hook must never block compaction
}

process.exit(0);
