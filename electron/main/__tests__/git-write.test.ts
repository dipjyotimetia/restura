import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitAddFiles,
  gitBranchList,
  gitCheckoutBranch,
  gitCommit,
  gitCreateBranch,
  gitDiscardFiles,
  gitFetch,
  gitInit,
  gitLog,
  gitPullFastForward,
  gitPush,
  gitStatus,
  gitUnstageFiles,
  setGitDirectoryAllowlist,
} from '../handlers/git-handler';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

describe.skipIf(!gitAvailable)('git write operations (temp repo)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'restura-git-'));
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@restura.dev'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Restura Test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    // Allow operations only against this temp directory.
    setGitDirectoryAllowlist((p) => p === dir);
  });

  afterAll(() => {
    setGitDirectoryAllowlist(() => false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stages and commits a file', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    await gitAddFiles(dir, ['a.txt']);
    const res = await gitCommit(dir, 'initial commit');
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.abbreviatedSha).toHaveLength(7);

    const log = await gitLog(dir, 10);
    expect(log[0]?.subject).toBe('initial commit');
    const status = await gitStatus(dir);
    expect(status.clean).toBe(true);
  });

  it('reports, stages, and commits OWS workspace artifacts as normal project files', async () => {
    const workflowDirectory = path.join(dir, 'workflows', 'billing');
    mkdirSync(workflowDirectory, { recursive: true });
    const files = [
      'workflows/billing/workflow.ows.json',
      'workflows/billing/bindings.restura.json',
      'workflows/billing/layout.restura.json',
    ];
    writeFileSync(
      path.join(workflowDirectory, 'workflow.ows.json'),
      '{"document":{"name":"billing"}}\n'
    );
    writeFileSync(
      path.join(workflowDirectory, 'bindings.restura.json'),
      '{"version":1,"tasks":{}}\n'
    );
    writeFileSync(
      path.join(workflowDirectory, 'layout.restura.json'),
      '{"version":1,"nodes":{}}\n'
    );

    // Git's porcelain status intentionally collapses an untracked directory;
    // once staged, every portable artifact is individually visible.
    expect((await gitStatus(dir)).files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'workflows/' })])
    );
    await gitAddFiles(dir, files);
    expect((await gitStatus(dir)).files.filter((file) => files.includes(file.path))).toEqual(
      expect.arrayContaining(files.map((path) => expect.objectContaining({ path, staged: 'A' })))
    );
    await expect(gitCommit(dir, 'add OWS workflow artifacts')).resolves.toMatchObject({
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
  });

  it('creates and switches branches', async () => {
    const status = await gitStatus(dir);
    const original = status.branch!;

    await gitCreateBranch(dir, 'feature/x');
    let branches = await gitBranchList(dir);
    expect(branches.find((b) => b.isCurrent)?.name).toBe('feature/x');

    await gitCheckoutBranch(dir, original);
    branches = await gitBranchList(dir);
    expect(branches.find((b) => b.isCurrent)?.name).toBe(original);
  });

  it('rejects operations outside the allowlist', async () => {
    await expect(gitCommit('/tmp/not-allowed', 'x')).rejects.toThrow(/not allowed/i);
  });

  it('rejects invalid branch names', async () => {
    await expect(gitCreateBranch(dir, 'bad name with spaces')).rejects.toThrow(/invalid ref/i);
  });

  it('classifies a real remote-tracking branch as remote, drops origin/HEAD', async () => {
    // Stand up a bare "remote" and a clone so `branch --all` produces real
    // refs/remotes/* entries plus the origin/HEAD symbolic pointer.
    const remoteDir = mkdtempSync(path.join(tmpdir(), 'restura-git-remote-'));
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'restura-git-clone-'));
    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteDir });
      execFileSync('git', ['remote', 'add', 'test-origin', remoteDir], { cwd: dir });
      execFileSync('git', ['push', '-u', 'test-origin', 'HEAD'], { cwd: dir });
      execFileSync('git', ['clone', remoteDir, cloneDir]);
      execFileSync('git', ['config', 'user.email', 'test@restura.dev'], { cwd: cloneDir });
      execFileSync('git', ['config', 'user.name', 'Restura Test'], { cwd: cloneDir });

      setGitDirectoryAllowlist((p) => p === dir || p === cloneDir);
      const branches = await gitBranchList(cloneDir);

      const remotes = branches.filter((b) => b.isRemote);
      expect(remotes.length).toBeGreaterThan(0);
      expect(remotes.every((b) => b.name.startsWith('origin/'))).toBe(true);
      // origin/HEAD must not surface as a phantom branch.
      expect(branches.some((b) => b.name === 'origin' || b.name.endsWith('/HEAD'))).toBe(false);
      // The current local branch is correctly marked, not remote.
      expect(branches.find((b) => b.isCurrent && !b.isRemote)).toBeDefined();
    } finally {
      execFileSync('git', ['remote', 'remove', 'test-origin'], { cwd: dir });
      setGitDirectoryAllowlist((p) => p === dir);
      rmSync(remoteDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it('does NOT execute a repo-local core.fsmonitor program during status', async () => {
    // Security regression: opening a hostile repo must not run its fsmonitor
    // program. runGit neutralises it with `-c core.fsmonitor=`.
    const sentinel = path.join(dir, 'FSMONITOR_RAN');
    const script = path.join(dir, 'evil-fsmonitor.sh');
    writeFileSync(script, `#!/bin/sh\ntouch "${sentinel}"\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: dir });
    try {
      await gitStatus(dir);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      execFileSync('git', ['config', '--unset', 'core.fsmonitor'], { cwd: dir });
      rmSync(script, { force: true });
      rmSync(sentinel, { force: true });
    }
  });

  it('initialises a repo in a plain directory (spinup path)', async () => {
    const plainDir = mkdtempSync(path.join(tmpdir(), 'restura-git-plain-'));
    try {
      setGitDirectoryAllowlist((p) => p === plainDir);
      // Not a repo yet — status fails with the stable not-a-repo code (the
      // renderer keys off this to offer "Initialize repository").
      await expect(gitStatus(plainDir)).rejects.toMatchObject({
        code: 'not-a-repo',
        message: expect.stringMatching(/not a git repository/i),
      });
      await gitInit(plainDir);
      expect(existsSync(path.join(plainDir, '.git'))).toBe(true);
      // Now status works.
      const status = await gitStatus(plainDir);
      expect(status.clean).toBe(true);
    } finally {
      setGitDirectoryAllowlist((p) => p === dir);
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('discards a newly staged file before the first commit', async () => {
    const unbornDir = mkdtempSync(path.join(tmpdir(), 'restura-git-unborn-'));
    try {
      execFileSync('git', ['init'], { cwd: unbornDir });
      setGitDirectoryAllowlist((p) => p === unbornDir);
      writeFileSync(path.join(unbornDir, 'new.yml'), 'name: new\n');
      await gitAddFiles(unbornDir, ['new.yml']);
      await gitDiscardFiles(unbornDir, ['new.yml']);
      expect(existsSync(path.join(unbornDir, 'new.yml'))).toBe(false);
      expect((await gitStatus(unbornDir)).clean).toBe(true);
    } finally {
      setGitDirectoryAllowlist((p) => p === dir);
      rmSync(unbornDir, { recursive: true, force: true });
    }
  });

  it('reports a missing collection directory distinctly from a missing git binary', async () => {
    // Allowlisted but never created → execFile resolves cwd to a missing path
    // (ENOENT), which must surface as 'directory-missing', not 'git-missing'.
    const parent = mkdtempSync(path.join(tmpdir(), 'restura-git-gone-'));
    const goneDir = path.join(parent, 'does-not-exist');
    setGitDirectoryAllowlist((p) => p === goneDir);
    try {
      await expect(gitStatus(goneDir)).rejects.toMatchObject({ code: 'directory-missing' });
    } finally {
      setGitDirectoryAllowlist((p) => p === dir);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('ignores inherited Git directory overrides outside the registered workspace', async () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = '/tmp/restura-redirected-git-dir';
    try {
      await expect(gitStatus(dir)).resolves.toMatchObject({ branch: expect.any(String) });
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it('rejects a local-path remote while preserving local staging controls', async () => {
    const remoteDir = mkdtempSync(path.join(tmpdir(), 'restura-git-sync-remote-'));
    const peerDir = mkdtempSync(path.join(tmpdir(), 'restura-git-sync-peer-'));
    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteDir });
      execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: dir });
      execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: dir });
      execFileSync('git', ['clone', remoteDir, peerDir]);
      execFileSync('git', ['config', 'user.email', 'peer@restura.dev'], { cwd: peerDir });
      execFileSync('git', ['config', 'user.name', 'Restura Peer'], { cwd: peerDir });

      setGitDirectoryAllowlist((p) => p === dir || p === peerDir);
      writeFileSync(path.join(peerDir, 'remote.txt'), 'from peer\n');
      execFileSync('git', ['add', 'remote.txt'], { cwd: peerDir });
      execFileSync('git', ['commit', '-m', 'peer change'], { cwd: peerDir });
      execFileSync('git', ['push'], { cwd: peerDir });

      await expect(gitFetch(dir)).rejects.toMatchObject({ code: 'invalid-remote-url' });
      await expect(gitPullFastForward(dir)).rejects.toMatchObject({ code: 'invalid-remote-url' });

      writeFileSync(path.join(dir, 'local.txt'), 'local\n');
      await gitAddFiles(dir, ['local.txt']);
      await gitUnstageFiles(dir, ['local.txt']);
      expect((await gitStatus(dir)).files.find((file) => file.path === 'local.txt')).toMatchObject({
        staged: '?',
      });
      await gitDiscardFiles(dir, ['local.txt']);
      expect(existsSync(path.join(dir, 'local.txt'))).toBe(false);

      writeFileSync(path.join(dir, 'pushed.txt'), 'pushed\n');
      await gitAddFiles(dir, ['pushed.txt']);
      await gitCommit(dir, 'commit through Restura');
      await expect(gitPush(dir)).rejects.toMatchObject({ code: 'invalid-remote-url' });
    } finally {
      setGitDirectoryAllowlist((p) => p === dir);
      rmSync(remoteDir, { recursive: true, force: true });
      rmSync(peerDir, { recursive: true, force: true });
    }
  });

  it('refuses a dirty fast-forward pull without changing the worktree', async () => {
    const remoteDir = mkdtempSync(path.join(tmpdir(), 'restura-git-dirty-remote-'));
    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteDir });
      execFileSync('git', ['remote', 'add', 'dirty-origin', remoteDir], { cwd: dir });
      execFileSync('git', ['push', '-u', 'dirty-origin', 'HEAD'], { cwd: dir });
      writeFileSync(path.join(dir, 'dirty.txt'), 'do not merge\n');
      await expect(gitPullFastForward(dir)).rejects.toMatchObject({ code: 'dirty-worktree' });
      expect(readFileSync(path.join(dir, 'dirty.txt'), 'utf8')).toBe('do not merge\n');
      rmSync(path.join(dir, 'dirty.txt'));
      execFileSync('git', ['remote', 'remove', 'dirty-origin'], { cwd: dir });
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});
