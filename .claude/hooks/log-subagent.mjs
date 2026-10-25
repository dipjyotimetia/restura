#!/usr/bin/env node
// SubagentStop hook — appends one TSV line per finished subagent to
// .claude/metrics/subagent.log so delegation is measurable before anyone
// restructures agents ("measure before you restructure").
//
// Columns: ISO timestamp, session_id, agent_type, agent_id, duration_ms, total_tokens.
//
// agent_type: Claude Code (verified against the 2.1.x CLI bundle) builds the
// payload as `agent_type: ctx.agentType ?? base.agent_type ?? ''`, so it can
// arrive as an EMPTY STRING even for a typed subagent. The same payload carries
// `background_tasks: [{ id, type: 'local_agent', agent_type, ... }]`, so fall
// back to the task whose id matches agent_id, then to alternative key spellings.
// The documented payload carries no duration/token fields today, so those
// columns are '-' unless a future payload supplies them as numbers.
//
// PRIVACY: metadata only. The payload's last_assistant_message,
// transcript_path, agent_transcript_path and background task descriptions /
// commands are deliberately never written.
// Contract: never throws, always exits 0, writes nothing to stdout.

import { appendMetric, readPayload } from './_shared.mjs';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function agentType(p) {
  const direct =
    str(p.agent_type) ??
    str(p.subagent_type) ??
    str(p.agentType) ??
    str(p.subagentType) ??
    str(p.agent?.type) ??
    str(p.agent?.agent_type) ??
    str(p.tool_input?.subagent_type);
  if (direct) return direct;
  if (Array.isArray(p.background_tasks) && p.agent_id) {
    const task = p.background_tasks.find((t) => t && t.id === p.agent_id);
    return str(task?.agent_type) ?? str(task?.agentType);
  }
  return undefined;
}

try {
  const p = readPayload();
  if (p && typeof p === 'object') {
    appendMetric('subagent.log', [
      p.session_id,
      agentType(p),
      p.agent_id,
      num(p.duration_ms) ?? num(p.total_duration_ms) ?? num(p.totalDurationMs),
      num(p.total_tokens) ?? num(p.totalTokens),
    ]);
  }
} catch {
  // intentionally empty — a metrics hook must never break the session
}

process.exit(0);
