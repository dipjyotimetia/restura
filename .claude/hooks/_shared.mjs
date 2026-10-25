// Shared helpers for Restura's Claude Code hooks.
//
// Dependency-free and written to never throw at import time, so any hook can
// import it safely. Hooks still own their own try/catch + always-exit-0
// contract; these helpers just remove the duplication (git changed-set,
// project-path checks, binary resolution, dedup markers) that was copy-pasted
// across the reminder/format hooks.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export const projectDir = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Read & parse the hook's JSON payload from stdin (also drains it). null on any error.
export function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// Absolute file path -> forward-slashed path relative to the project, or null
// if the file is outside the project (e.g. a /tmp scratch file).
export function projectRelative(file, cwd = projectDir()) {
  if (!file) return null;
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Local node_modules binary path, or null if dependencies aren't installed.
export function binPath(name, cwd = projectDir()) {
  const p = path.join(cwd, 'node_modules', '.bin', name);
  return existsSync(p) ? p : null;
}

// Files changed on this branch, computed in a SINGLE git pass:
//   committed = merge-base(default branch)..HEAD
//   working   = staged + unstaged (porcelain, rename-aware)
//   all       = union
// Returns forward-slashed repo-relative paths.
export function changedFiles(cwd = projectDir()) {
  const git = (cmd) =>
    execSync(`git ${cmd}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();

  let base = '';
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      base = git(`merge-base HEAD ${ref}`);
      if (base) break;
    } catch {
      // try next ref
    }
  }

  const committed = new Set();
  try {
    if (base) {
      for (const f of git(`diff --name-only ${base} HEAD`).split('\n')) {
        if (f) committed.add(f);
      }
    }
  } catch {
    // no committed diff available
  }

  const working = new Set();
  try {
    for (const line of git('status --porcelain').split('\n')) {
      if (!line) continue;
      const rest = line.slice(3);
      const name = rest.includes(' -> ') ? rest.split(' -> ').pop() : rest;
      if (name) working.add(name.trim().replace(/^"|"$/g, ''));
    }
  } catch {
    // no working tree changes available
  }

  return { committed, working, all: new Set([...committed, ...working]) };
}

// One-shot dedup: returns true only when `signature` differs from the last time
// this marker fired (and records the new signature). Marker lives in .git, so
// it's per-clone and never committed.
export function firstTimeFor(markerName, signature, cwd = projectDir()) {
  const markerPath = path.join(cwd, '.git', markerName);
  const hash = createHash('sha1').update(signature).digest('hex');
  let last = '';
  try {
    last = readFileSync(markerPath, 'utf8').trim();
  } catch {
    // no marker yet
  }
  if (last === hash) return false;
  try {
    writeFileSync(markerPath, hash);
  } catch {
    // best-effort; still fire
  }
  return true;
}

// Metrics: append one TSV line to .claude/metrics/<name> (gitignored runtime
// data). Each field is coerced to a single-line, tab-free token; empty/absent
// values become '-'. Best-effort — never throws. Callers pass METADATA ONLY
// (ids, names, counts) — never prompt, transcript, or message content.
export function tsvField(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value).replace(/[\t\r\n]+/g, ' ').slice(0, 200);
}

export function appendMetric(name, fields, cwd = projectDir()) {
  try {
    const logPath = path.join(cwd, '.claude', 'metrics', name);
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${[new Date().toISOString(), ...fields.map(tsvField)].join('\t')}\n`);
  } catch {
    // best-effort; metrics must never break a hook
  }
}
