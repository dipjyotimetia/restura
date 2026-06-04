#!/usr/bin/env node
// PreToolUse hook (matcher: Skill) — appends one line per skill invocation to
// .claude/metrics/skill-usage.log so under/over-triggering is observable over time.
// Per "Lessons from building Claude Code: how we use skills" (measurement via PreToolUse hooks).
// Non-blocking by contract: never throws, always exits 0, emits nothing on stdout.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// One catch-all: any failure (bad stdin, unparseable JSON, fs error) lands here
// and is swallowed — a metrics hook must never block tool use.
try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  if (payload.tool_name === 'Skill') {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const logPath = join(projectDir, '.claude', 'metrics', 'skill-usage.log');
    const skill = payload?.tool_input?.skill ?? 'unknown';
    const session = payload?.session_id ?? '-';
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()}\t${skill}\t${session}\n`);
  }
} catch {
  // intentionally empty
}

process.exit(0);
