import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  setGitDirectoryAllowlist,
  gitAddFiles,
  gitCommit,
  gitCreateBranch,
  gitCheckoutBranch,
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
});
