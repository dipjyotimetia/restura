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

describe('guard-bash hook: review-round bypasses', () => {
  it.each([
    'gh -R a/b pr merge 5 --admin',
    'gh --repo a/b pr merge 5 --admin',
    'gh --repo=a/b pr merge 5 --admin',
    'gh --hostname github.com pr merge 5 --admin',
    'gh pr merge 5 --admin=true',
  ])('denies gh admin merge with global flags: %j', (cmd) => {
    expect(run(cmd).denied).toBe(true);
  });

  it('allows --admin=false', () => {
    expect(run('gh pr merge 5 --auto --admin=false').denied).toBe(false);
  });

  it.each(['gh -R a/b pr create', 'gh --repo=a/b pr create --fill'])(
    'denies %j from a worktree cwd',
    (cmd) => {
      expect(run(cmd, { cwd: WORKTREE_CWD }).denied).toBe(true);
    }
  );

  it('denies git add -A after a heredoc whose body has an apostrophe', () => {
    const cmd = "git commit -F - <<'EOF'\nfix: don't drop\nEOF\ngit add -A";
    expect(run(cmd).denied).toBe(true);
  });

  it.each([
    "cat <<'EOF' > f\ngit add -A is bad\nEOF",
    'cat <<EOF > f\ngit add .\nEOF',
    'cat <<-"END"\n\tgit push\n\tEND',
  ])('allows heredoc bodies that merely mention commands: %j', (cmd) => {
    expect(run(cmd, { cwd: WORKTREE_CWD }).denied).toBe(false);
  });

  it('a quoted "<<X" does not swallow the following lines', () => {
    expect(run('echo "<<X"\ngit add -A').denied).toBe(true);
  });

  it('allows the $(cat <<EOF) commit-message idiom mentioning git add -A', () => {
    const cmd = "git commit -m \"$(cat <<'EOF'\nmsg: don't git add -A\nEOF\n)\"";
    expect(run(cmd).denied).toBe(false);
  });

  it('denies a heredoc fed to a shell', () => {
    expect(run("bash <<'EOF'\ngit add -A\nEOF").denied).toBe(true);
  });

  it('falls back to a conservative scan on tokenizer errors', () => {
    expect(run("echo 'unterminated && git add -A\ngit add --all").denied).toBe(true);
  });

  it.each([
    'echo `git add -A`',
    'echo "$(git add -A)"',
    'echo "`git add -A`"',
    'eval "git add -A"',
    'eval git add -A',
    'xargs git add -A',
    'xargs -n 1 -I {} git add -A',
    'timeout 5 git add -A',
    'timeout -s KILL 5 git add -A',
    'nice git add -A',
    'nice -n 10 git add -A',
    'nohup git add -A',
    'command git add -A',
    'env -i FOO=1 git add -A',
    'bash <<< "git add -A"',
    'bash -c "timeout 5 gh -R a/b pr merge 1 --admin"',
  ])('denies execution form %j', (cmd) => {
    expect(run(cmd).denied).toBe(true);
  });

  it.each([
    'git add *',
    'git add :/',
    'git add -u',
    'git add -u .',
    'git add --update .',
    'git add -n .',
    'git add --dry-run -A',
    'git add -p .',
    'git add --patch .',
    "echo 'eval git add -A'",
  ])('allows %j', (cmd) => {
    expect(run(cmd).denied).toBe(false);
  });

  it.each(['git add -f .', 'git add --force -A'])('still denies %j', (cmd) => {
    expect(run(cmd).denied).toBe(true);
  });
});

describe('guard-bash hook: bot-review round (PR #1185)', () => {
  it.each([
    'for f in a b; do git add -A; done',
    'while true; do git add -A; done',
    'until false; do git add .; done',
    'if true; then git add -A; fi',
    'if false; then :; else git add -A; fi',
    'if false; then :; elif true; then git add -A; fi',
    '{ git add -A; }',
    '! git add -A',
    '( git add -A )',
    'time git add -A',
    'case x in x) git add -A ;; esac',
  ])('denies git add behind a shell reserved word: %j', (cmd) => {
    expect(run(cmd).denied).toBe(true);
  });

  it.each(['if true; then git push; fi', 'for r in a; do git push; done', '{ git push; }'])(
    'denies %j from a worktree cwd',
    (cmd) => {
      expect(run(cmd, { cwd: WORKTREE_CWD }).denied).toBe(true);
    }
  );

  it.each(['if true; then git status; fi', 'for f in a; do echo "git add -A"; done'])(
    'allows harmless compound command %j',
    (cmd) => {
      expect(run(cmd).denied).toBe(false);
    }
  );

  it.each([
    'cd "$(pwd)" && git push',
    'cd "" && git push',
    'cd $HOME/x && git push',
    'cd `pwd` && git push',
    'cd ~someone && git push',
  ])('unresolvable cd target keeps the worktree dir: %j', (cmd) => {
    expect(run(cmd, { cwd: WORKTREE_CWD }).denied).toBe(true);
  });

  it.each([
    "sudo bash <<'EOF'\ngit add -A\nEOF",
    "env bash <<'EOF'\ngit add -A\nEOF",
    "FOO=1 bash <<'EOF'\ngit add -A\nEOF",
    "exec bash <<'EOF'\ngit add -A\nEOF",
    "timeout 5 sh <<'EOF'\ngit add -A\nEOF",
  ])('denies a heredoc fed to a wrapped shell: %j', (cmd) => {
    expect(run(cmd).denied).toBe(true);
  });

  it.each([
    'git commit -m "$(cat <<\'EOF\'\nfix (unbalanced paren and `backtick\nEOF\n)"',
    'git commit -m "$(cat <<\'EOF\'\nfix: never git add -A\nEOF\n)"',
  ])('allows a heredoc inside "$(…)": %j', (cmd) => {
    expect(run(cmd).denied).toBe(false);
  });

  it.each([
    'FOO="a b" bash <<\'EOF\'\ngit add -A\nEOF',
    "FOO='a b' sudo -E bash <<'EOF'\ngit add -A\nEOF",
    'A="x y" B=1 env bash <<\'EOF\'\ngit add -A\nEOF',
    'echo ok && FOO="a b" bash <<\'EOF\'\ngit add -A\nEOF',
  ])('denies a heredoc fed to a shell behind quoted env values: %j', (cmd) => {
    expect(run(cmd).denied).toBe(true);
  });

  it('treats the body as a script when the heredoc prefix cannot be tokenized', () => {
    expect(run('echo "unterminated <<EOF\ngit add -A\nEOF').denied).toBe(true);
  });

  it('still allows a quoted-env heredoc fed to a non-shell', () => {
    expect(run('FOO="a b" cat <<\'EOF\'\ngit add -A\nEOF').denied).toBe(false);
  });
});
