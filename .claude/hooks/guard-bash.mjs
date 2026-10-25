#!/usr/bin/env node
// PreToolUse(Bash) — hard gates for rules that used to live only in prose
// (CLAUDE.md "Agent brief checklist", the batch-ship command):
//
//   1. `git add -A | --all | .`      → stage explicit paths (a stray
//                                       node_modules symlink once reached main).
//   2. `gh pr merge … --admin`        → use the merge lane; --admin bypasses the
//                                       required checks. Override: an inline
//                                       `RESTURA_ALLOW_ADMIN=1` prefix on that
//                                       command, or the variable in the env.
//   3. `git push` / `gh pr create`    → denied inside .claude/worktrees/: worktree
//      from a .claude/worktrees/ dir    subagents report branch/SHA to the
//                                       orchestrator, which owns pushes and PRs.
//
// The command is tokenised shell-style (quotes, escapes, comments) and split on
// `&&`, `||`, `;`, `|`, `&`, newlines and subshell parens, so quoted text such as
// `echo "git add -A"` is not a false positive. `cd X` and `git -C X` move the
// effective directory for rule 3; `sh|bash|zsh -c "<cmd>"` is checked
// recursively.
//
// Output (per code.claude.com/docs/en/hooks): on deny, a PreToolUse JSON
// decision on stdout with exit 0. Contract: never throws; on any parse error or
// unexpected input it allows (exit 0, no output).

import { homedir } from 'node:os';
import * as path from 'node:path';
import { readPayload } from './_shared.mjs';

const REASONS = {
  gitAddAll:
    'Blocked: `git add -A` / `--all` / `.` stages everything, including stray files ' +
    '(a node_modules symlink once reached main this way). Stage explicit paths instead: ' +
    '`git add <path> <path>…`, then check `git show --stat` after committing.',
  adminMerge:
    'Blocked: `gh pr merge --admin` bypasses the required checks and the up-to-date rule. ' +
    'Use the merge lane instead: `gh pr merge <n> --auto --squash`. For a genuine emergency, ' +
    'prefix the command with `RESTURA_ALLOW_ADMIN=1` (or set it in the environment).',
  worktreePush:
    'Blocked: `git push` / `gh pr create` from a .claude/worktrees/ checkout. Worktree ' +
    'subagents do not push or open PRs — commit locally and report the branch, worktree ' +
    'path and HEAD SHA to the orchestrator, which owns pushes and PRs.',
};

// --- tokenizer --------------------------------------------------------------
// Returns an array of segments, each an array of words. Throws on unterminated
// quotes (the caller fails open).
export function splitCommand(cmd) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new Error('unterminated single quote');
      word += cmd.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && j + 1 < cmd.length) {
          j++;
          word += cmd[j];
        } else {
          word += cmd[j];
        }
      }
      if (j >= cmd.length) throw new Error('unterminated double quote');
      inWord = true;
      i = j;
    } else if (c === '\\') {
      if (cmd[i + 1] === '\n') {
        i++; // line continuation
      } else if (i + 1 < cmd.length) {
        word += cmd[++i];
        inWord = true;
      }
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === '#' && !inWord) {
      const nl = cmd.indexOf('\n', i);
      i = nl === -1 ? cmd.length : nl - 1;
    } else if (c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) {
      word += c; // redirection like 2>&1 or &>file, not a separator
      inWord = true;
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      if (c === '(' && word.endsWith('$')) word = word.slice(0, -1); // $( … )
      endSegment();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

// --- decision ---------------------------------------------------------------
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env']);
const SHELLS = new Set(['sh', 'bash', 'zsh']);

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);
const resolveDir = (base, target) => path.resolve(base || '/', expandHome(target));
const inWorktree = (dir) => /(^|\/)\.claude\/worktrees\/[^/]+/.test(String(dir).replace(/\\/g, '/'));

function isAddAllArg(a) {
  if (a === '-A' || a === '--all' || a === '.' || a === './') return true;
  return /^-[a-zA-Z]+$/.test(a) && a.includes('A');
}

// Returns a deny reason, or null. `state.dir` carries `cd` across segments.
function checkSegment(seg, state, env, depth) {
  let i = 0;
  const inlineEnv = {};
  for (; i < seg.length; i++) {
    const m = ENV_ASSIGN.exec(seg[i]);
    if (m) inlineEnv[m[1]] = m[2];
    else if (!WRAPPERS.has(seg[i])) break;
  }
  const words = seg.slice(i);
  const [cmd, ...rest] = words;
  if (!cmd) return null;
  const base = path.basename(cmd);

  if (SHELLS.has(base) && depth < 3) {
    const cIdx = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    const script = cIdx === -1 ? undefined : rest[cIdx + 1];
    return typeof script === 'string' ? checkCommand(script, state.dir, env, depth + 1) : null;
  }

  if (cmd === 'cd') {
    const target = rest.find((w) => !w.startsWith('-') || w === '-');
    if (target && target !== '-') state.dir = resolveDir(state.dir, target);
    else if (!target) state.dir = homedir();
    return null;
  }

  if (base === 'git') {
    let gitDir = state.dir;
    let j = 0;
    for (; j < rest.length; j++) {
      const w = rest[j];
      if (w === '-C') gitDir = resolveDir(gitDir, rest[++j] ?? '.');
      else if (w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') j++;
      else if (!w.startsWith('-')) break;
    }
    const sub = rest[j];
    const args = rest.slice(j + 1);
    if (sub === 'add' && args.some(isAddAllArg)) return REASONS.gitAddAll;
    if (sub === 'push' && inWorktree(gitDir)) return REASONS.worktreePush;
    return null;
  }

  if (base === 'gh' && rest[0] === 'pr') {
    if (rest[1] === 'merge' && rest.includes('--admin')) {
      const allowed = inlineEnv.RESTURA_ALLOW_ADMIN === '1' || env.RESTURA_ALLOW_ADMIN === '1';
      return allowed ? null : REASONS.adminMerge;
    }
    if (rest[1] === 'create' && inWorktree(state.dir)) return REASONS.worktreePush;
  }
  return null;
}

export function checkCommand(command, cwd, env = process.env, depth = 0) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const state = { dir: typeof cwd === 'string' && cwd ? cwd : process.cwd() };
  for (const seg of splitCommand(command)) {
    const reason = checkSegment(seg, state, env, depth);
    if (reason) return reason;
  }
  return null;
}

try {
  const payload = readPayload();
  const reason = checkCommand(payload?.tool_input?.command, payload?.cwd);
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })
    );
  }
} catch {
  // fail open — a parse error must never block the session
}

process.exit(0);
