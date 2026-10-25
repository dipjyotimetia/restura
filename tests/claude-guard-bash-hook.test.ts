import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK = resolve(process.cwd(), '.claude/hooks/guard-bash.mjs');
const MAIN_CWD = '/repo';
const WORKTREE_CWD = '/repo/.claude/worktrees/agent-abc';

interface Decision {
  denied: boolean;
  reason: string;
}

function run(
  command: unknown,
  opts: { cwd?: string; env?: Record<string, string>; raw?: string } = {}
): Decision {
  const env = { ...process.env, ...opts.env };
  if (!opts.env?.RESTURA_ALLOW_ADMIN) delete env.RESTURA_ALLOW_ADMIN;
  const input =
    opts.raw ??
    JSON.stringify({
      session_id: 'test',
      cwd: opts.cwd ?? MAIN_CWD,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    });
  const out = execFileSync('node', [HOOK], { input, env, encoding: 'utf8' });
  if (!out.trim()) return { denied: false, reason: '' };
  const parsed = JSON.parse(out) as {
    hookSpecificOutput?: {
      hookEventName?: string;
      permissionDecision?: string;
      permissionDecisionReason?: string;
    };
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
  return {
    denied: parsed.hookSpecificOutput?.permissionDecision === 'deny',
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

describe('guard-bash hook: git add', () => {
  it.each([
    'git add -A',
    'git add --all',
    'git add .',
    'git add ./',
    'git add -vA',
    'git -C /some/path add -A',
    'git -C sub add .',
    'cd src && git add -A',
    'npm test && git add . && git commit -m x',
    'npm test; git add --all',
    'false || git add -A',
    'echo hi | git add -A',
    'npm test\ngit add -A',
    '(cd src && git add .)',
    'FOO=1 git add -A',
    'bash -c "git add -A"',
    'git --no-pager add -A',
  ])('denies %j', (cmd) => {
    const d = run(cmd);
    expect(d.denied).toBe(true);
    expect(d.reason).toMatch(/explicit paths/i);
  });

  it.each([
    'git add ./src/x.ts',
    'git add .claude/foo',
    'git add src/a.ts tests/b.test.ts',
    'echo "git add -A"',
    "echo 'git add .'",
    'git commit -m "do not git add -A"',
    'git log --all',
    'git status',
    'grep -r "git add ." docs',
  ])('allows %j', (cmd) => {
    expect(run(cmd).denied).toBe(false);
  });
});

describe('guard-bash hook: gh pr merge --admin', () => {
  it.each([
    'gh pr merge 12 --admin --squash',
    'gh pr merge --squash --admin 12',
    'git fetch && gh pr merge 3 --admin',
  ])('denies %j', (cmd) => {
    const d = run(cmd);
    expect(d.denied).toBe(true);
    expect(d.reason).toContain('gh pr merge <n> --auto --squash');
    expect(d.reason).toContain('RESTURA_ALLOW_ADMIN=1');
  });

  it('allows with inline env override', () => {
    expect(run('RESTURA_ALLOW_ADMIN=1 gh pr merge 12 --admin --squash').denied).toBe(false);
  });

  it('inline override only applies to its own segment', () => {
    expect(run('RESTURA_ALLOW_ADMIN=1 echo ok && gh pr merge 12 --admin').denied).toBe(true);
  });

  it('allows with process env override', () => {
    expect(run('gh pr merge 12 --admin', { env: { RESTURA_ALLOW_ADMIN: '1' } }).denied).toBe(false);
  });

  it.each(['gh pr merge 12 --auto --squash', 'echo "gh pr merge 1 --admin"', 'gh pr view 12'])(
    'allows %j',
    (cmd) => {
      expect(run(cmd).denied).toBe(false);
    }
  );
});

describe('guard-bash hook: push / PR from worktrees', () => {
  it.each([
    'git push',
    'git push -u origin chore/x',
    'gh pr create --fill',
    'npm test && git push',
  ])('denies %j from a .claude/worktrees cwd', (cmd) => {
    const d = run(cmd, { cwd: WORKTREE_CWD });
    expect(d.denied).toBe(true);
    expect(d.reason).toMatch(/orchestrator/i);
  });

  it.each([
    'cd /repo/.claude/worktrees/agent-x && git push',
    'cd .claude/worktrees/agent-x && gh pr create',
    'git -C /repo/.claude/worktrees/agent-x push',
  ])('denies %j targeting a worktree from the main checkout', (cmd) => {
    expect(run(cmd, { cwd: MAIN_CWD }).denied).toBe(true);
  });

  it.each(['git push', 'gh pr create --fill', 'echo "git push"'])(
    'allows %j from the main checkout',
    (cmd) => {
      expect(run(cmd, { cwd: MAIN_CWD }).denied).toBe(false);
    }
  );

  it('allows non-push git commands inside worktrees', () => {
    expect(run('git status && git commit -m x', { cwd: WORKTREE_CWD }).denied).toBe(false);
  });

  it('cd out of the worktree before push is allowed', () => {
    expect(run('cd /repo && git push', { cwd: WORKTREE_CWD }).denied).toBe(false);
  });
});

describe('guard-bash hook: fail open', () => {
  it.each([
    ['garbage stdin', 'not json'],
    ['empty stdin', ''],
    ['missing command', JSON.stringify({ tool_name: 'Bash', tool_input: {} })],
    ['non-string command', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } })],
    ['unterminated quote', JSON.stringify({ tool_input: { command: 'echo "git add -A' } })],
  ])('allows on %s', (_name, raw) => {
    expect(run(undefined, { raw }).denied).toBe(false);
  });
});
