import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitAddFiles, gitCommit, gitDiff, setGitDirectoryAllowlist } from '../handlers/git-handler';
import { runGit } from '../handlers/git-runtime';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

// A compromised renderer that can plant repo-local git config must not get
// code execution through hooks or external diff drivers when main runs git.
describe.skipIf(!gitAvailable || process.platform === 'win32')('runGit hardening', () => {
  let dir: string;
  let marker: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'restura-git-harden-'));
    marker = `${dir}-pwned`;
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@restura.dev'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Restura Test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    setGitDirectoryAllowlist((p) => p === dir);
  });

  afterEach(() => {
    setGitDirectoryAllowlist(() => false);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(marker, { force: true });
  });

  function plantHook(hookDir: string): void {
    mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
  }

  it('does not run repo hooks from .git/hooks', async () => {
    plantHook(path.join(dir, '.git', 'hooks'));
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    await gitAddFiles(dir, ['a.txt']);
    await gitCommit(dir, 'commit');
    expect(existsSync(marker)).toBe(false);
  });

  it('does not run hooks from a repo-configured core.hooksPath', async () => {
    const hooks = path.join(dir, 'evil-hooks');
    plantHook(hooks);
    execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: dir });
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    await gitAddFiles(dir, ['a.txt']);
    await gitCommit(dir, 'commit');
    expect(existsSync(marker)).toBe(false);
  });

  it('does not run a repo-configured diff.external program', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: dir });
    writeFileSync(path.join(dir, 'a.txt'), 'changed');
    execFileSync('git', ['config', 'diff.external', `touch '${marker}'`], { cwd: dir });
    // A raw diff without --no-ext-diff fails closed (git cannot run the empty
    // override) rather than executing the planted program.
    await runGit(dir, ['diff']).catch(() => undefined);
    expect(existsSync(marker)).toBe(false);
    // The app's diff path (--no-ext-diff) still produces a normal patch.
    const patch = await gitDiff(dir, 'a.txt');
    expect(patch).toContain('+changed');
    expect(existsSync(marker)).toBe(false);
  });
});
