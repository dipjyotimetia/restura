import { describe, expect, it } from 'vitest';
import {
  GitError,
  gitRateLimiter,
  parseBranchList,
  parseCommitLog,
  parsePorcelainV2,
  sanitiseRefName,
  sanitiseRemoteUrl,
} from '../handlers/git-handler';

describe('parsePorcelainV2', () => {
  it('marks a clean tree', () => {
    const raw = ['# branch.oid 1234abcd', '# branch.head main', ''].join('\n');
    const r = parsePorcelainV2(raw);
    expect(r.clean).toBe(true);
    expect(r.branch).toBe('main');
    expect(r.files).toEqual([]);
  });

  it('parses modified file with index/working-tree distinction', () => {
    const raw = ['# branch.head main', '1 .M N... 100644 100644 100644 1111 2222 src/foo.ts'].join(
      '\n'
    );
    const r = parsePorcelainV2(raw);
    expect(r.clean).toBe(false);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: 'src/foo.ts', staged: '.', unstaged: 'M' });
  });

  it('parses untracked files', () => {
    const raw = ['# branch.head main', '? new-file.txt'].join('\n');
    const r = parsePorcelainV2(raw);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.staged).toBe('?');
    expect(r.files[0]?.path).toBe('new-file.txt');
  });

  it('extracts ahead/behind counters', () => {
    const raw = ['# branch.head main', '# branch.ab +2 -3'].join('\n');
    const r = parsePorcelainV2(raw);
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(3);
  });

  it('handles detached HEAD', () => {
    const raw = '# branch.head (detached)';
    const r = parsePorcelainV2(raw);
    expect(r.branch).toBeNull();
  });

  it('extracts the NEW path from rename "2" entries (porcelain v2: <newPath>\\t<origPath>)', () => {
    // Real git emits the current (new) path before the tab, original after.
    const raw = [
      '# branch.head main',
      '2 R. N... 100644 100644 100644 1111 2222 R100 new.txt\told.txt',
    ].join('\n');
    const r = parsePorcelainV2(raw);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.path).toBe('new.txt');
  });

  it('treats unmerged paths as dirty changes', () => {
    const raw = [
      '# branch.head main',
      'u UU N... 100644 100644 100644 100644 a b c conflict.yml',
    ].join('\n');
    const status = parsePorcelainV2(raw);
    expect(status.clean).toBe(false);
    expect(status.files).toEqual([expect.objectContaining({ path: 'conflict.yml' })]);
  });
});

describe('parseCommitLog', () => {
  it('parses SOH-separated commit lines', () => {
    const raw = [
      'abcdef0123456789\x01abcdef0\x01Alice\x01alice@example.com\x011700000000\x01Initial commit',
      'fedcba9876543210\x01fedcba9\x01Bob\x01bob@example.com\x011700001000\x01Fix bug: handle empty input',
    ].join('\n');
    const commits = parseCommitLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: 'abcdef0123456789',
      abbreviatedSha: 'abcdef0',
      author: 'Alice',
      email: 'alice@example.com',
      timestamp: 1700000000000,
      subject: 'Initial commit',
    });
    expect(commits[1]?.subject).toContain('Fix bug');
  });

  it('handles empty input', () => {
    expect(parseCommitLog('')).toEqual([]);
  });

  it('skips malformed lines silently', () => {
    const raw = [
      'abc\x01abc\x01alice\x01alice@x\x011700000000\x01ok',
      'malformed-line-without-separators',
      '',
    ].join('\n');
    const commits = parseCommitLog(raw);
    expect(commits).toHaveLength(1);
  });
});

describe('parseBranchList', () => {
  // Fixtures use the FULL refname (`%(refname)`) — what git actually emits for
  // `branch --all --format=%(refname)`. The previous fixtures used a `remotes/`
  // prefix git never produces, which is exactly why the isRemote bug shipped.
  it('identifies current branch and upstream', () => {
    const raw = [
      'refs/heads/main\torigin/main',
      'refs/heads/feature/new\torigin/feature/new',
      'refs/remotes/origin/main\t',
    ].join('\n');
    const branches = parseBranchList(raw, 'main');
    expect(branches).toHaveLength(3);
    const main = branches.find((b) => b.name === 'main' && !b.isRemote);
    expect(main?.isCurrent).toBe(true);
    expect(main?.upstream).toBe('origin/main');
  });

  it('classifies remote-tracking branches as remote (not local checkout targets)', () => {
    const raw = ['refs/heads/main\torigin/main', 'refs/remotes/origin/main\t'].join('\n');
    const branches = parseBranchList(raw, 'main');
    const remote = branches.find((b) => b.name === 'origin/main');
    expect(remote?.isRemote).toBe(true);
    expect(remote?.isCurrent).toBe(false);
    // Local list (what the checkout UI shows) must exclude it.
    expect(branches.filter((b) => !b.isRemote).map((b) => b.name)).toEqual(['main']);
  });

  it('drops the symbolic <remote>/HEAD pointer (no phantom bare "origin")', () => {
    const raw = [
      'refs/heads/main\torigin/main',
      'refs/remotes/origin/HEAD\t',
      'refs/remotes/origin/main\t',
    ].join('\n');
    const branches = parseBranchList(raw, 'main');
    expect(branches.map((b) => b.name)).toEqual(['main', 'origin/main']);
    expect(branches.some((b) => b.name === 'origin')).toBe(false);
  });

  it('returns empty array on empty input', () => {
    expect(parseBranchList('', null)).toEqual([]);
  });
});

describe('sanitiseRefName', () => {
  it('accepts normal branch names', () => {
    expect(sanitiseRefName('main')).toBe('main');
    expect(sanitiseRefName('feature/new-thing')).toBe('feature/new-thing');
    expect(sanitiseRefName('release-v1.2.3')).toBe('release-v1.2.3');
  });

  it('rejects leading dash', () => {
    expect(() => sanitiseRefName('-evil')).toThrow(GitError);
  });

  it('rejects ".." sequences', () => {
    expect(() => sanitiseRefName('foo..bar')).toThrow(GitError);
  });

  it('rejects "@{" sequences', () => {
    expect(() => sanitiseRefName('foo@{0}')).toThrow(GitError);
  });

  it('rejects colons', () => {
    expect(() => sanitiseRefName('foo:bar')).toThrow(GitError);
  });

  it('rejects shell-special characters', () => {
    expect(() => sanitiseRefName('foo;rm')).toThrow(GitError);
    expect(() => sanitiseRefName('foo bar')).toThrow(GitError);
    expect(() => sanitiseRefName('foo$BAR')).toThrow(GitError);
    expect(() => sanitiseRefName('`whoami`')).toThrow(GitError);
  });

  it('rejects empty input', () => {
    expect(() => sanitiseRefName('')).toThrow(GitError);
  });
});

describe('sanitiseRemoteUrl', () => {
  it('accepts HTTPS and SSH remotes without credentials', () => {
    expect(sanitiseRemoteUrl('https://github.com/restura/example.git')).toBe(
      'https://github.com/restura/example.git'
    );
    expect(sanitiseRemoteUrl('git@github.com:restura/example.git')).toBe(
      'git@github.com:restura/example.git'
    );
  });

  it('rejects local, insecure, and credential-bearing remote URLs', () => {
    expect(() => sanitiseRemoteUrl('/tmp/private-repo')).toThrow(GitError);
    expect(() => sanitiseRemoteUrl('file:///tmp/private-repo')).toThrow(GitError);
    expect(() => sanitiseRemoteUrl('http://example.com/repo.git')).toThrow(GitError);
    expect(() => sanitiseRemoteUrl('https://token@example.com/repo.git')).toThrow(GitError);
  });
});

describe('gitRateLimiter', () => {
  it('enforces a per-key budget of 120 requests/min', () => {
    const key = 'wc-git-test';
    for (let i = 0; i < 120; i++) {
      expect(gitRateLimiter.check(key)).toBe(true);
    }
    // 121st request in the window is rejected. (Per-key independence is covered
    // by ipc-rate-limiter.test.ts; here we only pin git's specific 120 budget.)
    expect(gitRateLimiter.check(key)).toBe(false);
    gitRateLimiter.dispose(key);
  });
});
