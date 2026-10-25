#!/usr/bin/env node
// PreToolUse(Bash) — hard gates for rules that used to live only in prose
// (CLAUDE.md "Agent brief checklist", the batch-ship command):
//
//   1. `git add -A | --all | .`      → stage explicit paths (a stray
//                                       node_modules symlink once reached main).
//                                       Allowed when -u/--update, -n/--dry-run or
//                                       -p/--patch is present (tracked-only or
//                                       non-staging). Globs (`*`, `:/`) allowed.
//   2. `gh pr merge … --admin`        → use the merge lane; --admin bypasses the
//                                       required checks. Override: an inline
//                                       `RESTURA_ALLOW_ADMIN=1` prefix on that
//                                       command segment, or the variable in the env.
//   3. `git push` / `gh pr create`    → denied inside .claude/worktrees/: worktree
//      from a .claude/worktrees/ dir    subagents report branch/SHA to the
//                                       orchestrator, which owns pushes and PRs.
//
// Parsing: heredoc bodies are stripped first (a body fed to sh/bash/zsh is
// checked as a script). The rest is tokenised shell-style (quotes, escapes,
// comments) and split on `&&`, `||`, `;`, `|`, `&`, newlines, parens and
// backticks, so quoted text such as `echo "git add -A"` is not a false positive.
// `$(…)` / backticks (also inside double quotes), `eval`, `sh -c`, here-strings
// and wrappers (env, timeout, xargs, nice, nohup, command, sudo, exec, time) are
// checked recursively. `cd X` and `git -C X` move the effective directory for
// rule 3. If the tokenizer fails (e.g. an unbalanced quote) a conservative scan
// with quoted strings removed runs instead of failing open.
//
// Output (per code.claude.com/docs/en/hooks): on deny, a PreToolUse JSON
// decision on stdout with exit 0. Contract: never throws; on unexpected input it
// allows (exit 0, no output).

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

const MAX_DEPTH = 4;

// --- heredocs -------------------------------------------------------------------
// True when position `idx` of a single line sits inside a quoted string.
function quotedAt(line, idx) {
  let q = '';
  for (let i = 0; i < idx; i++) {
    const c = line[i];
    if (q === "'") {
      if (c === "'") q = '';
    } else if (c === '\\') {
      i++;
    } else if (q === '"') {
      if (c === '"') q = '';
    } else if (c === "'" || c === '"') {
      q = c;
    }
  }
  return q !== '';
}

const HEREDOC = /(?<!<)<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/g;
const SHELL_BEFORE_HEREDOC = /(?:^|[;&|(`]|\$\()\s*(?:\S*\/)?(?:ba|z)?sh(?:\s+[^;&|<>]*)?\s*$/;

// Removes heredoc bodies (and terminator lines). Bodies whose command is a
// shell are returned separately so they can be checked as scripts.
export function stripHeredocs(cmd) {
  const out = [];
  const shellBodies = [];
  const pending = [];
  for (const line of cmd.split('\n')) {
    const cur = pending[0];
    if (cur) {
      const cmp = cur.dash ? line.replace(/^\t+/, '') : line;
      if (cmp.trim() === cur.tag) {
        pending.shift();
        if (cur.toShell) shellBodies.push(cur.body.join('\n'));
      } else {
        cur.body.push(line);
      }
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(HEREDOC)) {
      if (quotedAt(line, m.index)) continue;
      pending.push({
        dash: m[1] === '-',
        tag: m[3],
        body: [],
        toShell: SHELL_BEFORE_HEREDOC.test(line.slice(0, m.index)),
      });
    }
  }
  for (const p of pending) if (p.toShell) shellBodies.push(p.body.join('\n'));
  return { text: out.join('\n'), shellBodies };
}

// --- tokenizer -------------------------------------------------------------------
// Returns { segments: string[][], nested: string[] } where `nested` holds command
// substitutions found inside double quotes. Throws on unbalanced quotes.
export function splitCommand(cmd) {
  const segments = [];
  const nested = [];
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
        const d = cmd[j];
        if (d === '\\' && j + 1 < cmd.length) {
          word += cmd[++j];
        } else if (d === '`') {
          const end = cmd.indexOf('`', j + 1);
          if (end === -1) throw new Error('unterminated backtick');
          nested.push(cmd.slice(j + 1, end));
          j = end;
        } else if (d === '$' && cmd[j + 1] === '(') {
          let depth = 0;
          let k = j + 1;
          for (; k < cmd.length; k++) {
            if (cmd[k] === '(') depth++;
            else if (cmd[k] === ')' && --depth === 0) break;
          }
          if (k >= cmd.length) throw new Error('unterminated $(');
          nested.push(cmd.slice(j + 2, k));
          j = k;
        } else {
          word += d;
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
    } else if ('\n;&|()`'.includes(c)) {
      if (c === '(' && word.endsWith('$')) word = word.slice(0, -1); // $( … )
      endSegment();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return { segments, nested };
}

// Conservative fallback when the tokenizer fails: drop quoted strings (and any
// stray quote characters), then split on separators.
function fallbackSegments(text) {
  const s = text
    .replace(/'[^'\n]*'/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/g, ' ')
    .replace(/['"]/g, ' ');
  return s
    .split(/&&|\|\||[;&|\n()`]/)
    .map((x) => x.trim().split(/\s+/).filter(Boolean))
    .filter((a) => a.length > 0);
}

// --- decision -------------------------------------------------------------------
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SHELLS = new Set(['sh', 'bash', 'zsh']);
// Wrapper commands that execute their trailing argv, with the flags that take a
// separate value argument.
const WRAPPERS = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  xargs: new Set([
    '-n',
    '-I',
    '-P',
    '-L',
    '-d',
    '-s',
    '-E',
    '-a',
    '--max-args',
    '--max-procs',
    '--max-lines',
    '--delimiter',
    '--arg-file',
    '--replace',
    '--max-chars',
    '--eof',
  ]),
  nice: new Set(['-n', '--adjustment']),
  nohup: new Set(),
  command: new Set(),
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-U']),
  exec: new Set(['-a']),
  time: new Set(['-o', '-f']),
};
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);
const resolveDir = (base, target) => path.resolve(base || '/', expandHome(target));
const inWorktree = (dir) =>
  /(^|\/)\.claude\/worktrees\/[^/]+/.test(String(dir).replace(/\\/g, '/'));

const isShortFlags = (a) => /^-[a-zA-Z]+$/.test(a);
function isAddAllArg(a) {
  if (a === '-A' || a === '--all' || a === '.' || a === './') return true;
  return isShortFlags(a) && a.includes('A');
}
// -u/--update and -p/--patch only touch tracked files; -n/--dry-run stages nothing.
const ADD_SAFE_LONG = new Set(['--update', '--dry-run', '--patch']);
const isAddSafeArg = (a) => ADD_SAFE_LONG.has(a) || (isShortFlags(a) && /[unp]/.test(a));

// Returns a deny reason, or null. `state.dir` carries `cd` across segments.
function checkSegment(seg, state, env, depth) {
  const inlineEnv = {};
  let i = 0;
  while (i < seg.length) {
    const m = ENV_ASSIGN.exec(seg[i]);
    if (m) {
      inlineEnv[m[1]] = m[2];
      i++;
      continue;
    }
    const wrapper = path.basename(seg[i]);
    const valueFlags = Object.hasOwn(WRAPPERS, wrapper) ? WRAPPERS[wrapper] : null;
    if (!valueFlags) break;
    i++;
    while (i < seg.length && seg[i].startsWith('-') && seg[i] !== '-') {
      if (seg[i] === '--') {
        i++;
        break;
      }
      i += valueFlags.has(seg[i]) ? 2 : 1;
    }
    if (wrapper === 'timeout') i++; // duration
  }

  const [cmd, ...rest] = seg.slice(i);
  if (!cmd) return null;
  const base = path.basename(cmd);

  if (cmd === 'eval') {
    return rest.length ? checkCommand(rest.join(' '), state.dir, env, depth + 1) : null;
  }

  if (SHELLS.has(base)) {
    const cIdx = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    if (cIdx !== -1 && typeof rest[cIdx + 1] === 'string') {
      return checkCommand(rest[cIdx + 1], state.dir, env, depth + 1);
    }
    const hsIdx = rest.indexOf('<<<');
    const hereString =
      hsIdx !== -1 ? rest[hsIdx + 1] : rest.find((w) => w.startsWith('<<<'))?.slice(3);
    return hereString ? checkCommand(hereString, state.dir, env, depth + 1) : null;
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
    if (sub === 'add' && !args.some(isAddSafeArg) && args.some(isAddAllArg)) {
      return REASONS.gitAddAll;
    }
    if (sub === 'push' && inWorktree(gitDir)) return REASONS.worktreePush;
    return null;
  }

  if (base === 'gh') {
    let k = 0;
    while (k < rest.length && rest[k].startsWith('-')) k += GH_VALUE_FLAGS.has(rest[k]) ? 2 : 1;
    if (rest[k] !== 'pr') return null;
    const sub = rest[k + 1];
    const args = rest.slice(k + 2);
    if (sub === 'merge') {
      const admin = args.some(
        (a) => a === '--admin' || (a.startsWith('--admin=') && a !== '--admin=false')
      );
      if (!admin) return null;
      const allowed = inlineEnv.RESTURA_ALLOW_ADMIN === '1' || env.RESTURA_ALLOW_ADMIN === '1';
      return allowed ? null : REASONS.adminMerge;
    }
    if (sub === 'create' && inWorktree(state.dir)) return REASONS.worktreePush;
  }
  return null;
}

export function checkCommand(command, cwd, env = process.env, depth = 0) {
  if (typeof command !== 'string' || !command.trim() || depth > MAX_DEPTH) return null;
  const state = { dir: typeof cwd === 'string' && cwd ? cwd : process.cwd() };
  const { text, shellBodies } = stripHeredocs(command);

  let parsed;
  try {
    parsed = splitCommand(text);
  } catch {
    parsed = { segments: fallbackSegments(text), nested: [] };
  }

  for (const seg of parsed.segments) {
    const reason = checkSegment(seg, state, env, depth);
    if (reason) return reason;
  }
  for (const sub of [...parsed.nested, ...shellBodies]) {
    const reason = checkCommand(sub, state.dir, env, depth + 1);
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
  // fail open — an internal hook error must never block the session
}

process.exit(0);
