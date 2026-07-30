/**
 * Git-native collections main-process handler. Every operation is allowlist
 * gated, serialised per workspace, shell-free, and neutralises repo-local
 * fsmonitor. System Git handles SSH-agent and credential-manager auth; Restura
 * never accepts, stores, or exposes Git credentials. Hooks remain enabled.
 */

import type { GitBranch, GitCommit, GitStatus, GitStatusFile } from '@shared/git-types';
import { loadCollectionDirectory } from '@shared/opencollection/node/fs-reader';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain } from 'electron';
import { existsSync } from 'fs';
import * as path from 'path';
import type { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import {
  assertTrustedSender,
  GitAddFilesInputSchema,
  GitCloneInputSchema,
  GitCommitInputSchema,
  GitDiffInputSchema,
  GitDirectoryInputSchema,
  GitLogInputSchema,
  GitMergeCompleteSchema,
  GitMergeConflictSchema,
  GitMergeResolutionSchema,
  GitMergeStartSchema,
  GitRefInputSchema,
} from '../ipc/ipc-validators';
import { isPathRealSafe } from '../storage/file-operations';
import {
  gitAbortMerge,
  gitCompleteMerge,
  gitGetMergeConflict,
  gitMergeState,
  gitResolveMergeConflict,
  gitStartMerge,
} from './git-merge-handler';
import {
  ensureDirectoryAllowed,
  GitError,
  resolveWithin,
  runGit,
  sanitiseCloneDirectoryName,
  sanitiseRefName,
  sanitiseRemoteUrl,
  withGitLock as withLock,
} from './git-runtime';

export {
  GitError,
  sanitiseRefName,
  sanitiseRemoteUrl,
  setGitDirectoryAllowlist,
} from './git-runtime';

const log = createLogger('git');

/** Per-webContents budget; registered for cleanup in window-manager.ts. */
export const gitRateLimiter = createKeyedRateLimiter(120, 60_000);

export type { GitBranch, GitCommit, GitStatus, GitStatusFile };

export function parsePorcelainV2(raw: string): GitStatus {
  const files: GitStatusFile[] = [];
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim();
      branch = name === '(detached)' ? null : name;
    } else if (line.startsWith('# branch.ab ')) {
      const parts = line.slice('# branch.ab '.length).trim().split(' ');
      ahead = Number((parts[0] ?? '+0').replace(/[+-]/g, '')) || 0;
      behind = Number((parts[1] ?? '-0').replace(/[+-]/g, '')) || 0;
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const xy = line.split(' ')[1] ?? '..';
      const isRename = line.startsWith('2 ');
      const isUnmerged = line.startsWith('u ');
      const beforeTab = line.split('\t')[0] ?? '';
      const filePath = isRename
        ? beforeTab.split(' ').slice(9).join(' ')
        : isUnmerged
          ? line.split(' ').slice(10).join(' ')
          : line.split(' ').slice(8).join(' ');
      if (filePath) {
        files.push({
          path: filePath,
          staged: xy.charAt(0),
          unstaged: xy.charAt(1),
        });
      }
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), staged: '?', unstaged: '?' });
    } else if (line.startsWith('! ')) {
    }
  }

  return { files, branch, ahead, behind, clean: files.length === 0 };
}

/**
 * Parse `git log --pretty=format:%H%x01%h%x01%an%x01%ae%x01%at%x01%s`.
 * The 0x01 SOH byte separator is highly unlikely to appear in real commit
 * subjects, making this resilient to commit-message punctuation.
 *
 * Malformed lines are skipped, but the count of skipped lines is emitted as
 * a single `log.warn` so anyone debugging git-native collections can see
 * whether the parser is silently dropping data.
 */
export function parseCommitLog(raw: string): GitCommit[] {
  const out: GitCommit[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [sha, abbr, author, email, ts, subject] = line.split('\x01');
    if (!sha || !abbr || !ts) {
      skipped += 1;
      continue;
    }
    out.push({
      sha,
      abbreviatedSha: abbr,
      author: author ?? '',
      email: email ?? '',
      timestamp: Number(ts) * 1000,
      subject: subject ?? '',
    });
  }
  if (skipped > 0) {
    log.warn('parseCommitLog skipped malformed lines — git log format may have changed', {
      skipped,
    });
  }
  return out;
}

/**
 * Parse `git branch --list --all --format='%(refname)\t%(upstream:short)'`
 * preceded by HEAD detection via a separate `--show-current` call.
 *
 * We use the FULL refname (`refs/heads/x`, `refs/remotes/origin/x`) rather than
 * `%(refname:short)` because the short form is the only signal of remoteness and
 * it is ambiguous: `git branch --all` emits a remote `origin/main` as the bare
 * `origin/main`, indistinguishable from a (legal) local branch literally named
 * `origin/main`. With the full refname, `refs/remotes/` is an unambiguous remote
 * marker. The symbolic `refs/remotes/<remote>/HEAD` pointer is dropped — it's not
 * a checkout target, and surfacing it produced a phantom bare `origin` entry.
 */
export function parseBranchList(raw: string, currentBranch: string | null): GitBranch[] {
  const out: GitBranch[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [refRaw, upstreamRaw, oidRaw] = line.split('\t');
    const ref = refRaw?.trim();
    if (!ref) continue;

    let name: string;
    let isRemote: boolean;
    if (ref.startsWith('refs/remotes/')) {
      isRemote = true;
      name = ref.slice('refs/remotes/'.length);
      // Skip the symbolic `<remote>/HEAD` pointer (e.g. refs/remotes/origin/HEAD).
      if (name.endsWith('/HEAD')) continue;
    } else if (ref.startsWith('refs/heads/')) {
      isRemote = false;
      name = ref.slice('refs/heads/'.length);
    } else {
      isRemote = false;
      name = ref;
    }

    out.push({
      name,
      isCurrent: !isRemote && currentBranch !== null && name === currentBranch,
      isRemote,
      ...(upstreamRaw && upstreamRaw.trim() ? { upstream: upstreamRaw.trim() } : {}),
      ...(oidRaw && oidRaw.trim() ? { oid: oidRaw.trim() } : {}),
    });
  }
  return out;
}

export async function gitStatus(directoryPath: string): Promise<GitStatus> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    return statusFromGit(dir);
  });
}

async function statusFromGit(dir: string): Promise<GitStatus> {
  const raw = await runGit(dir, ['status', '--porcelain=v2', '--branch']);
  return parsePorcelainV2(raw);
}

export async function gitLog(directoryPath: string, limit = 50): Promise<GitCommit[]> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    const raw = await runGit(dir, [
      'log',
      `-n${limit}`,
      '--pretty=format:%H%x01%h%x01%an%x01%ae%x01%at%x01%s',
    ]);
    return parseCommitLog(raw);
  });
}

export async function gitDiff(
  directoryPath: string,
  filePath: string,
  staged = false
): Promise<string> {
  const dir = ensureDirectoryAllowed(directoryPath);
  const abs = path.resolve(dir, filePath);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) {
    throw new GitError(`File path escapes the collection directory: ${filePath}`, 'invalid-input');
  }
  return withLock(dir, async () => {
    const raw = await runGit(dir, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      ...(staged ? ['--cached'] : []),
      '--',
      filePath,
    ]);
    return raw;
  });
}

export async function gitBranchList(directoryPath: string): Promise<GitBranch[]> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    const [current, list] = await Promise.all([
      runGit(dir, ['branch', '--show-current']).then((s) => s.trim() || null),
      runGit(dir, [
        'branch',
        '--list',
        '--all',
        '--format=%(refname)\t%(upstream:short)\t%(objectname)',
      ]),
    ]);
    return parseBranchList(list, current);
  });
}

export async function gitInit(directoryPath: string): Promise<true> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    await runGit(dir, ['init']);
    return true as const;
  });
}

export async function gitAddFiles(directoryPath: string, filePaths: string[]): Promise<true> {
  const dir = ensureDirectoryAllowed(directoryPath);
  for (const fp of filePaths) resolveWithin(dir, fp);
  return withLock(dir, async () => {
    await runGit(dir, ['add', '--', ...filePaths]);
    return true as const;
  });
}

/** Remove selected paths from the index while preserving their working-tree content. */
export async function gitUnstageFiles(directoryPath: string, filePaths: string[]): Promise<true> {
  const dir = ensureDirectoryAllowed(directoryPath);
  for (const fp of filePaths) resolveWithin(dir, fp);
  return withLock(dir, async () => {
    await runGit(dir, ['restore', '--staged', '--', ...filePaths]);
    return true as const;
  });
}

/**
 * Discard selected paths after explicit renderer confirmation. Tracked files
 * are restored from HEAD; untracked paths are removed with a path-scoped
 * `git clean -f`. There is deliberately no broad "discard all" command.
 */
export async function gitDiscardFiles(directoryPath: string, filePaths: string[]): Promise<true> {
  const dir = ensureDirectoryAllowed(directoryPath);
  for (const fp of filePaths) resolveWithin(dir, fp);
  return withLock(dir, async () => {
    const status = await statusFromGit(dir);
    const selected = new Set(filePaths);
    const untracked = status.files
      .filter((file) => selected.has(file.path) && file.staged === '?')
      .map((file) => file.path);
    const hasHead = await runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      .then(() => true)
      .catch(() => false);
    const unbornStaged = !hasHead
      ? status.files
          .filter((file) => selected.has(file.path) && file.staged === 'A')
          .map((file) => file.path)
      : [];
    const tracked = filePaths.filter(
      (filePath) => !untracked.includes(filePath) && !unbornStaged.includes(filePath)
    );
    if (tracked.length > 0) {
      await runGit(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
    }
    if (untracked.length > 0) {
      await runGit(dir, ['clean', '-f', '--', ...untracked]);
    }
    if (unbornStaged.length > 0) {
      await runGit(dir, ['rm', '--cached', '--', ...unbornStaged]);
      await runGit(dir, ['clean', '-f', '--', ...unbornStaged]);
    }
    return true as const;
  });
}

/**
 * Commit staged changes (optionally staging everything first). Returns the new
 * commit's full + abbreviated SHA. Fails clearly when there's nothing to commit
 * or when git identity (user.name/email) isn't configured — we never set it.
 */
export async function gitCommit(
  directoryPath: string,
  message: string,
  options: { all?: boolean; paths?: string[] } = {}
): Promise<{ sha: string; abbreviatedSha: string }> {
  const dir = ensureDirectoryAllowed(directoryPath);
  if (options.paths) for (const p of options.paths) resolveWithin(dir, p);
  return withLock(dir, async () => {
    if (options.all) await runGit(dir, ['add', '-A']);
    const args = ['commit', '-m', message];
    if (options.paths && options.paths.length > 0) args.push('--', ...options.paths);
    await runGit(dir, args);
    const sha = (await runGit(dir, ['rev-parse', 'HEAD'])).trim();
    return { sha, abbreviatedSha: sha.slice(0, 7) };
  });
}

export async function gitCreateBranch(directoryPath: string, name: string): Promise<string> {
  const dir = ensureDirectoryAllowed(directoryPath);
  const ref = sanitiseRefName(name);
  return withLock(dir, async () => {
    await runGit(dir, ['checkout', '-b', ref]);
    return ref;
  });
}

export async function gitCheckoutBranch(directoryPath: string, name: string): Promise<string> {
  const dir = ensureDirectoryAllowed(directoryPath);
  const ref = sanitiseRefName(name);
  return withLock(dir, async () => {
    await runGit(dir, ['checkout', ref]);
    return ref;
  });
}

function remoteNameFromUpstream(upstream: string): string {
  const [remote] = upstream.split('/');
  if (!remote) throw new GitError('The current branch has no upstream branch.', 'no-upstream');
  return sanitiseRefName(remote);
}

async function currentBranchAndUpstream(
  dir: string
): Promise<{ branch: string; upstream: string }> {
  const branch = (await runGit(dir, ['branch', '--show-current'])).trim();
  if (!branch)
    throw new GitError(
      'Cannot sync while HEAD is detached. Check out a branch first.',
      'detached-head'
    );
  try {
    const upstream = (
      await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    ).trim();
    if (!upstream) throw new GitError('The current branch has no upstream branch.', 'no-upstream');
    return { branch: sanitiseRefName(branch), upstream };
  } catch (error) {
    if (error instanceof GitError && error.code === 'git-error') {
      throw new GitError(
        'The current branch has no upstream branch. Push it to publish the branch.',
        'no-upstream'
      );
    }
    throw error;
  }
}

async function defaultRemote(dir: string): Promise<string> {
  const remotes = (await runGit(dir, ['remote']))
    .split('\n')
    .map((remote) => remote.trim())
    .filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) throw new GitError('No Git remote is configured for this workspace.', 'no-remote');
  return sanitiseRefName(remote);
}

async function validatedRemote(dir: string, remote: string, push = false): Promise<void> {
  sanitiseRemoteUrl(
    (await runGit(dir, ['remote', 'get-url', ...(push ? ['--push'] : []), remote])).trim()
  );
}

export async function gitFetch(directoryPath: string): Promise<{ remote: string }> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    const remote = await defaultRemote(dir);
    await validatedRemote(dir, remote);
    await runGit(dir, ['fetch', '--prune', remote]);
    return { remote };
  });
}

/** Fetch and integrate only a fast-forward update. Merge/rebase conflicts stay external. */
export async function gitPullFastForward(directoryPath: string): Promise<{ updated: boolean }> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    if (!(await statusFromGit(dir)).clean) {
      throw new GitError(
        'Commit, stage, or discard local changes before pulling.',
        'dirty-worktree'
      );
    }
    const { upstream } = await currentBranchAndUpstream(dir);
    const remote = remoteNameFromUpstream(upstream);
    await validatedRemote(dir, remote);
    await runGit(dir, ['fetch', '--prune', remote]);
    try {
      await runGit(dir, ['merge', '--ff-only', upstream]);
    } catch (error) {
      if (error instanceof GitError) {
        throw new GitError(
          'The remote branch cannot be fast-forwarded. Resolve or merge it externally, then refresh.',
          'non-fast-forward'
        );
      }
      throw error;
    }
    return { updated: true };
  });
}

/** Push the current branch, publishing it to origin on first push when needed. */
export async function gitPush(directoryPath: string): Promise<{ remote: string; branch: string }> {
  const dir = ensureDirectoryAllowed(directoryPath);
  return withLock(dir, async () => {
    const branch = (await runGit(dir, ['branch', '--show-current'])).trim();
    if (!branch)
      throw new GitError(
        'Cannot push while HEAD is detached. Check out a branch first.',
        'detached-head'
      );
    const safeBranch = sanitiseRefName(branch);
    let remote: string;
    let upstream: string | null = null;
    let hasUpstream = true;
    try {
      upstream = (await currentBranchAndUpstream(dir)).upstream;
      remote = remoteNameFromUpstream(upstream);
    } catch (error) {
      if (!(error instanceof GitError) || error.code !== 'no-upstream') throw error;
      remote = await defaultRemote(dir);
      hasUpstream = false;
    }
    await validatedRemote(dir, remote, true);
    try {
      const remoteBranch = upstream?.slice(remote.length + 1);
      await runGit(
        dir,
        hasUpstream && remoteBranch
          ? ['push', remote, `refs/heads/${safeBranch}:refs/heads/${sanitiseRefName(remoteBranch)}`]
          : ['push', '--set-upstream', remote, safeBranch]
      );
    } catch (error) {
      if (
        error instanceof GitError &&
        /non-fast-forward|rejected|fetch first/i.test(error.message)
      ) {
        throw new GitError(
          'Push was rejected because the remote branch has newer history. Pull and resolve it externally first.',
          'push-rejected'
        );
      }
      throw error;
    }
    return { remote, branch: safeBranch };
  });
}

/**
 * Clone a remote into a user-selected safe parent directory and verify that it
 * is an OpenCollection workspace before returning it to the renderer. This
 * intentionally does not register the directory: the existing collection
 * loader performs registration only after its own load/validation succeeds.
 */
export async function gitCloneWorkspace(
  parentDirectory: string,
  remoteUrl: string,
  directoryName: string
): Promise<{ directoryPath: string }> {
  const parent = path.resolve(parentDirectory);
  if (!(await isPathRealSafe(parent)) || !existsSync(parent)) {
    throw new GitError(
      'Choose an existing folder that Restura can access for the clone.',
      'forbidden'
    );
  }
  const destination = path.resolve(parent, sanitiseCloneDirectoryName(directoryName));
  if (!destination.startsWith(parent + path.sep) || existsSync(destination)) {
    throw new GitError(
      'The clone destination must be a new folder inside the selected directory.',
      'invalid-input'
    );
  }
  await runGit(parent, ['clone', '--', sanitiseRemoteUrl(remoteUrl), destination]);
  try {
    await loadCollectionDirectory(destination);
  } catch {
    throw new GitError(
      'Repository cloned, but it is not a valid OpenCollection workspace. No collection was opened.',
      'invalid-workspace'
    );
  }
  return { directoryPath: destination };
}

function ipcCommand<T, R>(
  schema: z.ZodType<T>,
  resultKey: string,
  run: (data: T) => Promise<R>
): (e: Electron.IpcMainInvokeEvent, payload: unknown) => Promise<Record<string, unknown>> {
  return async (e, payload) => {
    // Defense-in-depth: reject IPC from any frame that isn't the trusted
    // renderer entry point before touching the filesystem / git.
    assertTrustedSender('git', e);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    try {
      return { ok: true, [resultKey]: await run(parsed.data) };
    } catch (err) {
      // Carry the structured GitError.code (e.g. 'not-a-repo', 'directory-missing')
      // so the renderer can branch on a stable signal instead of the message.
      const code = errorCode(err);
      return { ok: false, error: errorMessage(err), ...(code ? { code } : {}) };
    }
  };
}

export function registerGitHandlerIPC(): void {
  // Every git command runs behind the shared per-webContents rate limiter
  // (defense-in-depth: git ops are already allowlist-gated + per-dir serialised).
  const handle = <T>(
    channel: string,
    schema: z.ZodType<T>,
    resultKey: string,
    run: (data: T) => Promise<unknown>
  ): void => {
    ipcMain.handle(channel, rateLimited(gitRateLimiter, ipcCommand(schema, resultKey, run)));
  };

  handle(IPC.git.init, GitDirectoryInputSchema, 'initialized', ({ directoryPath }) =>
    gitInit(directoryPath)
  );
  handle(IPC.git.status, GitDirectoryInputSchema, 'status', ({ directoryPath }) =>
    gitStatus(directoryPath)
  );
  handle(IPC.git.log, GitLogInputSchema, 'commits', ({ directoryPath, limit }) =>
    gitLog(directoryPath, limit ?? 50)
  );
  handle(IPC.git.diff, GitDiffInputSchema, 'diff', ({ directoryPath, filePath, staged }) =>
    gitDiff(directoryPath, filePath, staged)
  );
  handle(IPC.git.branchList, GitDirectoryInputSchema, 'branches', ({ directoryPath }) =>
    gitBranchList(directoryPath)
  );
  handle(IPC.git.add, GitAddFilesInputSchema, 'staged', ({ directoryPath, filePaths }) =>
    gitAddFiles(directoryPath, filePaths)
  );
  handle(IPC.git.unstage, GitAddFilesInputSchema, 'unstaged', ({ directoryPath, filePaths }) =>
    gitUnstageFiles(directoryPath, filePaths)
  );
  handle(IPC.git.discard, GitAddFilesInputSchema, 'discarded', ({ directoryPath, filePaths }) =>
    gitDiscardFiles(directoryPath, filePaths)
  );
  handle(IPC.git.commit, GitCommitInputSchema, 'commit', ({ directoryPath, message, all, paths }) =>
    gitCommit(directoryPath, message, {
      ...(all !== undefined ? { all } : {}),
      ...(paths !== undefined ? { paths } : {}),
    })
  );
  handle(IPC.git.createBranch, GitRefInputSchema, 'branch', ({ directoryPath, name }) =>
    gitCreateBranch(directoryPath, name)
  );
  handle(IPC.git.checkoutBranch, GitRefInputSchema, 'branch', ({ directoryPath, name }) =>
    gitCheckoutBranch(directoryPath, name)
  );
  handle(IPC.git.fetch, GitDirectoryInputSchema, 'remote', ({ directoryPath }) =>
    gitFetch(directoryPath)
  );
  handle(IPC.git.pull, GitDirectoryInputSchema, 'result', ({ directoryPath }) =>
    gitPullFastForward(directoryPath)
  );
  handle(IPC.git.push, GitDirectoryInputSchema, 'result', ({ directoryPath }) =>
    gitPush(directoryPath)
  );
  handle(
    IPC.git.clone,
    GitCloneInputSchema,
    'workspace',
    ({ parentDirectory, remoteUrl, directoryName }) =>
      gitCloneWorkspace(parentDirectory, remoteUrl, directoryName)
  );
  handle(IPC.git.mergeState, GitDirectoryInputSchema, 'state', ({ directoryPath }) =>
    gitMergeState(directoryPath)
  );
  handle(
    IPC.git.mergeStart,
    GitMergeStartSchema,
    'outcome',
    ({ directoryPath, sourceRef, expectedSha }) =>
      gitStartMerge(directoryPath, sourceRef, expectedSha)
  );
  handle(
    IPC.git.mergeConflict,
    GitMergeConflictSchema,
    'conflict',
    ({ directoryPath, conflictId }) => gitGetMergeConflict(directoryPath, conflictId)
  );
  handle(IPC.git.mergeResolve, GitMergeResolutionSchema, 'state', ({ directoryPath, resolution }) =>
    gitResolveMergeConflict(directoryPath, resolution)
  );
  handle(IPC.git.mergeAbort, GitDirectoryInputSchema, 'result', ({ directoryPath }) =>
    gitAbortMerge(directoryPath)
  );
  handle(IPC.git.mergeComplete, GitMergeCompleteSchema, 'commit', ({ directoryPath, message }) =>
    gitCompleteMerge(directoryPath, message)
  );
}

export function unregisterGitHandlerIPC(): void {
  ipcMain.removeHandler(IPC.git.init);
  ipcMain.removeHandler(IPC.git.status);
  ipcMain.removeHandler(IPC.git.log);
  ipcMain.removeHandler(IPC.git.diff);
  ipcMain.removeHandler(IPC.git.branchList);
  ipcMain.removeHandler(IPC.git.add);
  ipcMain.removeHandler(IPC.git.unstage);
  ipcMain.removeHandler(IPC.git.discard);
  ipcMain.removeHandler(IPC.git.commit);
  ipcMain.removeHandler(IPC.git.createBranch);
  ipcMain.removeHandler(IPC.git.checkoutBranch);
  ipcMain.removeHandler(IPC.git.fetch);
  ipcMain.removeHandler(IPC.git.pull);
  ipcMain.removeHandler(IPC.git.push);
  ipcMain.removeHandler(IPC.git.clone);
  ipcMain.removeHandler(IPC.git.mergeState);
  ipcMain.removeHandler(IPC.git.mergeStart);
  ipcMain.removeHandler(IPC.git.mergeConflict);
  ipcMain.removeHandler(IPC.git.mergeResolve);
  ipcMain.removeHandler(IPC.git.mergeAbort);
  ipcMain.removeHandler(IPC.git.mergeComplete);
}

function errorMessage(err: unknown): string {
  if (err instanceof GitError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorCode(err: unknown): string | undefined {
  return err instanceof GitError ? err.code : undefined;
}
