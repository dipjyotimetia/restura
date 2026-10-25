#!/usr/bin/env node
// SubagentStop hook — appends one TSV line per finished subagent to
// .claude/metrics/subagent.log so delegation is measurable before anyone
// restructures agents ("measure before you restructure").
//
// Columns: ISO timestamp, session_id, agent_type, agent_id, duration_ms, total_tokens.
// The documented SubagentStop payload (code.claude.com/docs/en/hooks) carries no
// duration/token fields today, so those columns are '-' unless a future payload
// supplies them as numbers.
//
// PRIVACY: metadata only. The payload's last_assistant_message,
// transcript_path and agent_transcript_path are deliberately never read.
// Contract: never throws, always exits 0, writes nothing to stdout.

import { appendMetric, readPayload } from './_shared.mjs';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

try {
  const p = readPayload();
  if (p && typeof p === 'object') {
    appendMetric('subagent.log', [
      p.session_id,
      p.agent_type,
      p.agent_id,
      num(p.duration_ms) ?? num(p.total_duration_ms) ?? num(p.totalDurationMs),
      num(p.total_tokens) ?? num(p.totalTokens),
    ]);
  }
} catch {
  // intentionally empty — a metrics hook must never break the session
}

process.exit(0);
