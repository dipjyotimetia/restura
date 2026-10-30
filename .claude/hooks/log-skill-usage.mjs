#!/usr/bin/env node
// PreToolUse hook (matcher: Skill) — appends one TSV line per skill invocation to
// .claude/metrics/skill-usage.log so under/over-triggering is observable over time.
// Per "Lessons from building Claude Code: how we use skills" (measurement via PreToolUse hooks).
//
// Columns: ISO timestamp, skill name, session_id. Names and ids only — never
// the skill arguments or any prompt content.
// Non-blocking by contract: never throws, always exits 0, emits nothing on stdout.

import { appendMetric, readPayload } from './_shared.mjs';

try {
  const payload = readPayload();
  if (payload?.tool_name === 'Skill') {
    appendMetric('skill-usage.log', [payload.tool_input?.skill ?? 'unknown', payload.session_id]);
  }
} catch {
  // intentionally empty — a metrics hook must never block tool use
}

process.exit(0);
