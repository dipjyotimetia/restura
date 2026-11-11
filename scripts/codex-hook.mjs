#!/usr/bin/env node
// Adapts Codex lifecycle-hook payloads to the repository's shared Claude/Codex
// hook scripts. Keep this layer small: policy and checks remain single-source.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const action = process.argv[2];
const stdin = readFileSync(0, 'utf8');
let payload;
try {
  payload = JSON.parse(stdin);
} catch {
  process.exit(0);
}

let root = process.cwd();
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: payload.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  // Keep hook behavior best-effort outside a Git checkout.
}

const hookNames = {
  'session-start': 'session-start.mjs',
  'guard-bash': 'guard-bash.mjs',
  'guard-generated-files': 'guard-generated-files.mjs',
  'format-edit': 'format-edit.mjs',
  'stop-checks': 'stop-checks.mjs',
  'log-subagent': 'log-subagent.mjs',
  'log-compaction': 'log-compaction.mjs',
};
const hookName = hookNames[action];
if (!hookName) process.exit(0);

function run(hookPayload) {
  const result = spawnSync(process.execPath, [path.join(root, '.claude/hooks', hookName)], {
    cwd: root,
    env: { ...process.env, RESTURA_AGENT_RUNTIME: 'codex' },
    input: JSON.stringify(hookPayload),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return { status: 0, stdout: '', stderr: '' };
  return result;
}

// Codex exposes apply_patch as a command string. The shared Claude hooks accept
// one file path at a time, so extract patch headers and adapt each path.
function patchPaths(command) {
  if (typeof command !== 'string') return [];
  const paths = new Set();
  for (const match of command.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    paths.add(match[1].trim());
  }
  for (const match of command.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    paths.add(match[1].trim());
  }
  return [...paths].filter((file) => file && file !== '/dev/null');
}

if (action === 'guard-bash') {
  const result = run(payload);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.status === 2 ? 2 : 0);
}

if (action === 'guard-generated-files' || action === 'format-edit') {
  const files = patchPaths(payload.tool_input?.command);
  for (const file of files) {
    const adapted = {
      ...payload,
      tool_input: { ...payload.tool_input, file_path: path.resolve(root, file) },
    };
    const result = run(adapted);
    if (action === 'guard-generated-files' && result.status === 2) {
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(2);
    }
  }
  process.exit(0);
}

const result = run(payload);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status === 2 ? 2 : 0);
