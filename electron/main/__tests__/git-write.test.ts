import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  setGitDirectoryAllowlist,
  gitAddFiles,
  gitCommit,
  gitCreateBranch,
  gitCheckoutBranch,
  gitInit,
  gitStatus,
  gitLog,
  gitBranchList,
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
      execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: dir });
      execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: dir });
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
      // Not a repo yet — status fails.
      await expect(gitStatus(plainDir)).rejects.toThrow(/not a git repository/i);
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
});
