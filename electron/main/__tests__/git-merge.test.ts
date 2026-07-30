import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyStructuredChoices } from '@shared/git-merge';
import { serializeOpenCollectionMergeFile } from '@shared/opencollection/merge-file';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setGitDirectoryAllowlist } from '../handlers/git-handler';
import {
  gitAbortMerge,
  gitCompleteMerge,
  gitGetMergeConflict,
  gitMergeState,
  gitResolveMergeConflict,
  gitStartMerge,
} from '../handlers/git-merge-handler';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

describe.skipIf(!gitAvailable)('git merge operations (temp repo)', () => {
  let directory: string;

  beforeEach(() => {
    directory = createWorkspace();
    setGitDirectoryAllowlist((candidate) => candidate === directory);
  });

  afterEach(() => {
    setGitDirectoryAllowlist(() => false);
    rmSync(directory, { recursive: true, force: true });
  });

  it('fast-forwards without leaving merge metadata', async () => {
    git(['checkout', '-b', 'incoming']);
    writeFileSync(path.join(directory, 'incoming.txt'), 'incoming\n');
    commitAll('incoming');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);

    await expect(gitStartMerge(directory, 'incoming', incomingSha)).resolves.toEqual({
      kind: 'fast-forward',
      head: incomingSha,
    });
    await expect(gitMergeState(directory)).resolves.toEqual({
      phase: 'idle',
      branch: 'main',
      dirty: false,
    });
    expect(git(['rev-parse', 'HEAD'])).toBe(incomingSha);
  });

  it('pauses a clean non-fast-forward merge until explicit commit', async () => {
    const base = git(['rev-parse', 'HEAD']);
    git(['checkout', '-b', 'incoming']);
    writeFileSync(path.join(directory, 'incoming.txt'), 'incoming\n');
    commitAll('incoming');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    writeFileSync(path.join(directory, 'local.txt'), 'local\n');
    commitAll('local');
    const localHead = git(['rev-parse', 'HEAD']);

    const outcome = await gitStartMerge(directory, 'incoming', incomingSha);
    expect(outcome.kind).toBe('ready-to-commit');
    expect(git(['rev-parse', 'HEAD'])).toBe(localHead);
    expect(git(['rev-parse', 'MERGE_HEAD'])).toBe(incomingSha);
    expect(base).not.toBe(localHead);

    const result = await gitCompleteMerge(directory, 'Merge incoming');
    expect(result.sha).toBe(git(['rev-parse', 'HEAD']));
    expect(git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
  });

  it('recovers a structured OpenCollection conflict and stages an explicit resolution', async () => {
    const requestPath = path.join(directory, 'users', 'get-users.yaml');
    git(['checkout', '-b', 'incoming']);
    writeFileSync(requestPath, requestYaml('https://incoming.example/users'));
    commitAll('incoming URL');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    writeFileSync(requestPath, requestYaml('https://local.example/users'));
    commitAll('local URL');

    const outcome = await gitStartMerge(directory, 'incoming', incomingSha);
    expect(outcome.kind).toBe('conflicted');

    // Reading state again simulates reopening Restura after interruption.
    const recovered = await gitMergeState(directory);
    expect(recovered.phase).toBe('conflicted');
    if (recovered.phase !== 'conflicted') throw new Error('expected conflicted merge');
    expect(recovered.conflicts).toHaveLength(1);

    const detail = await gitGetMergeConflict(directory, recovered.conflicts[0]!.id);
    expect(detail.strategy).toBe('structured');
    expect(detail.structured?.conflicts.map((conflict) => conflict.path)).toEqual(['/http/url']);

    const resolved = applyStructuredChoices(detail.structured!, {
      '/http/url': 'incoming',
    });
    await gitResolveMergeConflict(directory, {
      conflictId: detail.id,
      kind: 'content',
      content: serializeOpenCollectionMergeFile(resolved),
    });

    await expect(gitMergeState(directory)).resolves.toMatchObject({ phase: 'ready-to-commit' });
    expect(readFileSync(requestPath, 'utf8')).toContain('https://incoming.example/users');
    expect(git(['diff', '--name-only', '--diff-filter=U'])).toBe('');
  });

  it('rejects invalid OpenCollection content before it reaches the index', async () => {
    const requestPath = path.join(directory, 'users', 'get-users.yaml');
    git(['checkout', '-b', 'incoming']);
    writeFileSync(requestPath, requestYaml('https://incoming.example/users'));
    commitAll('incoming URL');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    writeFileSync(requestPath, requestYaml('https://local.example/users'));
    commitAll('local URL');
    await gitStartMerge(directory, 'incoming', incomingSha);
    const state = await gitMergeState(directory);
    if (state.phase !== 'conflicted') throw new Error('expected conflicted merge');

    await expect(
      gitResolveMergeConflict(directory, {
        conflictId: state.conflicts[0]!.id,
        kind: 'content',
        content: 'value: not-an-opencollection-request\n',
      })
    ).rejects.toMatchObject({ code: 'invalid-resolution' });
    expect(git(['diff', '--name-only', '--diff-filter=U'])).toBe('users/get-users.yaml');
  });

  it('aborts to the exact pre-merge HEAD and tracked worktree', async () => {
    const requestPath = path.join(directory, 'users', 'get-users.yaml');
    git(['checkout', '-b', 'incoming']);
    writeFileSync(requestPath, requestYaml('https://incoming.example/users'));
    commitAll('incoming URL');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    writeFileSync(requestPath, requestYaml('https://local.example/users'));
    commitAll('local URL');
    const beforeHead = git(['rev-parse', 'HEAD']);
    const beforeContent = readFileSync(requestPath, 'utf8');

    await gitStartMerge(directory, 'incoming', incomingSha);
    await expect(gitAbortMerge(directory)).resolves.toEqual({ aborted: true });

    expect(git(['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(readFileSync(requestPath, 'utf8')).toBe(beforeContent);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('refuses dirty, detached, and stale-ref merge attempts', async () => {
    git(['checkout', '-b', 'incoming']);
    writeFileSync(path.join(directory, 'incoming.txt'), 'incoming\n');
    commitAll('incoming');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);

    writeFileSync(path.join(directory, 'dirty.txt'), 'dirty\n');
    await expect(gitStartMerge(directory, 'incoming', incomingSha)).rejects.toMatchObject({
      code: 'dirty-worktree',
    });
    rmSync(path.join(directory, 'dirty.txt'));

    await expect(gitStartMerge(directory, 'incoming', '0'.repeat(40))).rejects.toMatchObject({
      code: 'stale-ref',
    });

    git(['checkout', '--detach']);
    await expect(gitStartMerge(directory, 'incoming', incomingSha)).rejects.toMatchObject({
      code: 'detached-head',
    });
  });

  it('classifies add/add and modify/delete conflicts and resolves applicable sides', async () => {
    git(['checkout', '-b', 'incoming']);
    writeFileSync(path.join(directory, 'added.txt'), 'incoming\n');
    rmSync(path.join(directory, 'users', 'get-users.yaml'));
    commitAll('incoming add and delete');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    writeFileSync(path.join(directory, 'added.txt'), 'local\n');
    writeFileSync(
      path.join(directory, 'users', 'get-users.yaml'),
      requestYaml('https://local.example/users')
    );
    commitAll('local add and modify');

    await gitStartMerge(directory, 'incoming', incomingSha);
    const state = await gitMergeState(directory);
    if (state.phase !== 'conflicted') throw new Error('expected conflicted merge');
    expect(state.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'added.txt', status: 'both-added' }),
        expect.objectContaining({
          path: 'users/get-users.yaml',
          status: 'deleted-by-incoming',
        }),
      ])
    );

    const added = state.conflicts.find((conflict) => conflict.path === 'added.txt')!;
    await gitResolveMergeConflict(directory, {
      conflictId: added.id,
      kind: 'choice',
      choice: 'incoming',
    });
    const deletion = await gitMergeState(directory);
    if (deletion.phase !== 'conflicted') throw new Error('expected remaining conflict');
    await gitResolveMergeConflict(directory, {
      conflictId: deletion.conflicts[0]!.id,
      kind: 'choice',
      choice: 'delete',
    });

    expect(readFileSync(path.join(directory, 'added.txt'), 'utf8')).toBe('incoming\n');
    expect(exists('users/get-users.yaml')).toBe(false);
  });

  it('groups a rename/rename conflict into one related-path decision', async () => {
    writeFileSync(path.join(directory, 'old.txt'), 'same\n');
    commitAll('add old path');
    git(['checkout', '-b', 'incoming']);
    git(['mv', 'old.txt', 'theirs.txt']);
    commitAll('incoming rename');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    git(['mv', 'old.txt', 'ours.txt']);
    commitAll('local rename');

    await gitStartMerge(directory, 'incoming', incomingSha);
    const state = await gitMergeState(directory);
    if (state.phase !== 'conflicted') throw new Error('expected conflicted merge');

    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]).toMatchObject({
      status: 'rename',
      relatedPaths: ['old.txt', 'ours.txt', 'theirs.txt'],
    });

    await gitResolveMergeConflict(directory, {
      conflictId: state.conflicts[0]!.id,
      kind: 'choice',
      choice: 'incoming',
    });
    await expect(gitMergeState(directory)).resolves.toMatchObject({ phase: 'ready-to-commit' });
    expect(exists('theirs.txt')).toBe(true);
    expect(exists('old.txt')).toBe(false);
    expect(exists('ours.txt')).toBe(false);
  });

  it('uses choice-only resolution for binary, oversized, and symlink conflicts', async () => {
    writeFileSync(path.join(directory, 'binary.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(directory, 'large.txt'), `${'x'.repeat(1024 * 1024 + 1)}\n`);
    symlinkSync('base-target', path.join(directory, 'linked'));
    commitAll('special baselines');
    git(['checkout', '-b', 'incoming']);
    writeFileSync(path.join(directory, 'binary.bin'), Buffer.from([0, 3, 2]));
    writeFileSync(path.join(directory, 'large.txt'), `${'i'.repeat(1024 * 1024 + 1)}\n`);
    rmSync(path.join(directory, 'linked'));
    symlinkSync('incoming-target', path.join(directory, 'linked'));
    commitAll('incoming special files');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    writeFileSync(path.join(directory, 'binary.bin'), Buffer.from([0, 4, 2]));
    writeFileSync(path.join(directory, 'large.txt'), `${'l'.repeat(1024 * 1024 + 1)}\n`);
    rmSync(path.join(directory, 'linked'));
    symlinkSync('local-target', path.join(directory, 'linked'));
    commitAll('local special files');

    await gitStartMerge(directory, 'incoming', incomingSha);
    const state = await gitMergeState(directory);
    if (state.phase !== 'conflicted') throw new Error('expected conflicted merge');
    const details = await Promise.all(
      state.conflicts.map((conflict) => gitGetMergeConflict(directory, conflict.id))
    );

    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'binary.bin', kind: 'binary', strategy: 'choice-only' }),
        expect.objectContaining({ path: 'large.txt', kind: 'oversized', strategy: 'choice-only' }),
        expect.objectContaining({ path: 'linked', kind: 'symlink', strategy: 'choice-only' }),
      ])
    );
  });

  it('leaves the merge recoverable when a commit hook rejects it', async () => {
    git(['checkout', '-b', 'incoming']);
    writeFileSync(path.join(directory, 'incoming.txt'), 'incoming\n');
    commitAll('incoming');
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    writeFileSync(path.join(directory, 'local.txt'), 'local\n');
    commitAll('local');
    await gitStartMerge(directory, 'incoming', incomingSha);
    const hook = path.join(directory, '.git', 'hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);

    await expect(gitCompleteMerge(directory, 'Rejected merge')).rejects.toMatchObject({
      code: 'git-error',
    });
    await expect(gitMergeState(directory)).resolves.toMatchObject({ phase: 'ready-to-commit' });
  });

  it('reports another in-progress Git operation instead of starting a merge', async () => {
    const head = git(['rev-parse', 'HEAD']);
    writeFileSync(path.join(directory, '.git', 'CHERRY_PICK_HEAD'), `${head}\n`);

    await expect(gitMergeState(directory)).resolves.toEqual({
      phase: 'blocked',
      branch: 'main',
      operation: 'cherry-pick',
    });
    await expect(gitStartMerge(directory, 'main', head)).rejects.toMatchObject({
      code: 'operation-in-progress',
    });
  });

  it('reports submodule conflicts as unsupported without changing the index', async () => {
    const baseTarget = git(['commit-tree', 'HEAD^{tree}', '-m', 'base gitlink target']);
    git(['update-index', '--add', '--cacheinfo', '160000', baseTarget, 'vendor/dependency']);
    git(['commit', '-m', 'add gitlink']);
    git(['checkout', '-b', 'incoming']);
    const incomingTarget = git(['commit-tree', 'HEAD^{tree}', '-m', 'incoming gitlink target']);
    git(['update-index', '--cacheinfo', '160000', incomingTarget, 'vendor/dependency']);
    git(['commit', '-m', 'incoming gitlink']);
    const incomingSha = git(['rev-parse', 'incoming']);
    git(['checkout', 'main']);
    const localTarget = git(['commit-tree', 'HEAD^{tree}', '-m', 'local gitlink target']);
    git(['update-index', '--cacheinfo', '160000', localTarget, 'vendor/dependency']);
    git(['commit', '-m', 'local gitlink']);

    await gitStartMerge(directory, 'incoming', incomingSha);
    const state = await gitMergeState(directory);
    if (state.phase !== 'conflicted') throw new Error('expected conflicted merge');
    const detail = await gitGetMergeConflict(directory, state.conflicts[0]!.id);
    expect(detail).toMatchObject({ kind: 'submodule', strategy: 'unsupported' });

    await expect(
      gitResolveMergeConflict(directory, {
        conflictId: detail.id,
        kind: 'choice',
        choice: 'incoming',
      })
    ).rejects.toMatchObject({ code: 'unsupported-conflict' });
    expect(git(['diff', '--name-only', '--diff-filter=U'])).toBe('vendor/dependency');
  });

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  }

  function commitAll(message: string): void {
    git(['add', '-A']);
    git(['commit', '-m', message]);
  }

  function exists(relativePath: string): boolean {
    try {
      readFileSync(path.join(directory, relativePath));
      return true;
    } catch {
      return false;
    }
  }
});

function createWorkspace(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'restura-git-merge-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'test@restura.dev'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Restura Test'], { cwd: directory });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: directory });
  mkdirSync(path.join(directory, 'users'));
  writeFileSync(
    path.join(directory, 'opencollection.yml'),
    ['opencollection: "1.0.0"', 'info:', '  name: "Merge Test"', 'bundled: false', ''].join('\n')
  );
  writeFileSync(
    path.join(directory, 'users', 'get-users.yaml'),
    requestYaml('https://base.example/users')
  );
  execFileSync('git', ['add', '-A'], { cwd: directory });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: directory });
  return directory;
}

function requestYaml(url: string): string {
  return [
    'info:',
    '  type: "http"',
    '  name: "Get users"',
    'http:',
    '  method: "GET"',
    `  url: "${url}"`,
    '',
  ].join('\n');
}
