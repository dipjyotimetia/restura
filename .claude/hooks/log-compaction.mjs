#!/usr/bin/env node
// PreCompact hook — records one line per context compaction to
// .claude/metrics/compaction.log so how often sessions hit the context limit is
// observable over time (a rising rate is a signal that CLAUDE.md / tool output /
// context is getting heavy and worth trimming). Pairs with log-skill-usage.mjs.
//
// Columns: ISO timestamp, trigger ('manual' | 'auto'), session_id. The
// transcript path is deliberately NOT logged: metrics hold names, ids and
// counts only, never paths or content.
//
// Observability only: it NEVER blocks compaction (exit 2 would). Best-effort —
// never throws, always exits 0, emits nothing on stdout.

import { appendMetric, readPayload } from './_shared.mjs';

try {
  const payload = readPayload();
  if (payload) appendMetric('compaction.log', [payload.trigger ?? 'unknown', payload.session_id]);
} catch {
  // intentionally empty — an observability hook must never block compaction
}

process.exit(0);
