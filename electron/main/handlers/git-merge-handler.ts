import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStructuredMerge } from '@shared/git-merge';
import type {
  GitConflictResolution,
  GitConflictSide,
  GitMergeConflictDetail,
  GitMergeConflictSummary,
  GitMergeOutcome,
  GitMergeState,
} from '@shared/git-types';
import {
  detectOpenCollectionMergeFile,
  parseOpenCollectionMergeFile,
  serializeOpenCollectionMergeFile,
} from '@shared/opencollection/merge-file';
import { loadCollectionDirectory } from '@shared/opencollection/node/fs-reader';
import {
  ensureDirectoryAllowed,
  GitError,
  resolveWithin,
  runGit,
  sanitiseRefName,
  withGitLock,
} from './git-runtime';

const MAX_CONFLICT_BLOB_BYTES = 1024 * 1024;
const MAX_RESOLUTION_BYTES = 2 * 1024 * 1024;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

interface IndexStage {
  mode: string;
  oid: string;
  stage: 1 | 2 | 3;
  path: string;
}

interface ConflictRecord {
  summary: GitMergeConflictSummary;
  stages: Map<1 | 2 | 3, IndexStage>;
}

export async function gitMergeState(directoryPath: string): Promise<GitMergeState> {
  const directory = ensureDirectoryAllowed(directoryPath);
  return withGitLock(directory, () => mergeStateFromGit(directory));
}

export async function gitStartMerge(
  directoryPath: string,
  sourceRef: string,
  expectedSha: string
): Promise<GitMergeOutcome> {
  const directory = ensureDirectoryAllowed(directoryPath);
  const safeRef = sanitiseRefName(sourceRef);
  if (!OBJECT_ID_RE.test(expectedSha)) {
    throw new GitError('The selected branch commit is invalid.', 'invalid-input');
  }
  return withGitLock(directory, async () => {
    const initial = await mergeStateFromGit(directory);
    if (
      initial.phase === 'blocked' ||
      initial.phase === 'conflicted' ||
      initial.phase === 'ready-to-commit'
    ) {
      throw new GitError(
        'Finish or abort the existing Git operation first.',
        'operation-in-progress'
      );
    }
    if (!initial.branch) {
      throw new GitError(
        'Cannot merge while HEAD is detached. Check out a branch first.',
        'detached-head'
      );
    }
    if (initial.dirty) {
      throw new GitError(
        'Commit, stage, or discard local changes before merging.',
        'dirty-worktree'
      );
    }

    const resolvedSha = (await runGit(directory, ['rev-parse', '--verify', `${safeRef}^{commit}`]))
      .trim()
      .toLowerCase();
    if (resolvedSha !== expectedSha.toLowerCase()) {
      throw new GitError(
        'The selected branch changed after it was loaded. Refresh branches and try again.',
        'stale-ref'
      );
    }

    try {
      await runGit(directory, ['merge', '--no-commit', '--no-edit', safeRef]);
    } catch (error) {
      const state = await mergeStateFromGit(directory);
      if (state.phase !== 'conflicted') throw error;
      return { kind: 'conflicted', state };
    }

    const state = await mergeStateFromGit(directory);
    if (state.phase === 'conflicted') return { kind: 'conflicted', state };
    if (state.phase === 'ready-to-commit') return { kind: 'ready-to-commit', state };
    const head = (await runGit(directory, ['rev-parse', 'HEAD'])).trim();
    return { kind: 'fast-forward', head };
  });
}

export async function gitGetMergeConflict(
  directoryPath: string,
  conflictId: string
): Promise<GitMergeConflictDetail> {
  const directory = ensureDirectoryAllowed(directoryPath);
  return withGitLock(directory, async () => {
    const conflict = await currentConflict(directory, conflictId);
    return conflictDetail(directory, conflict);
  });
}

export async function gitResolveMergeConflict(
  directoryPath: string,
  resolution: GitConflictResolution
): Promise<GitMergeState> {
  const directory = ensureDirectoryAllowed(directoryPath);
  return withGitLock(directory, async () => {
    const conflict = await currentConflict(directory, resolution.conflictId);
    const detail = await conflictDetail(directory, conflict);
    if (detail.strategy === 'unsupported') {
      throw new GitError(
        'Submodule conflicts must be resolved with external Git.',
        'unsupported-conflict'
      );
    }

    if (resolution.kind === 'content') {
      if (Buffer.byteLength(resolution.content, 'utf8') > MAX_RESOLUTION_BYTES) {
        throw new GitError('Resolved content exceeds the 2 MiB limit.', 'resolution-too-large');
      }
      if (detail.strategy === 'choice-only') {
        throw new GitError(
          'This conflict only supports choosing a side or deleting it.',
          'invalid-resolution'
        );
      }
      if (detail.openCollectionKind) {
        try {
          parseOpenCollectionMergeFile(detail.path, resolution.content, detail.openCollectionKind);
        } catch (error) {
          throw new GitError((error as Error).message, 'invalid-resolution');
        }
      }
      if (detail.relatedPaths.length > 1) {
        await clearConflictPaths(directory, detail.relatedPaths);
      }
      await safeWriteConflictFile(directory, detail.path, resolution.content);
      await runGit(directory, ['add', '--', detail.path]);
    } else if (resolution.choice === 'delete') {
      await clearConflictPaths(directory, detail.relatedPaths);
    } else {
      const stage = resolution.choice === 'base' ? 1 : resolution.choice === 'local' ? 2 : 3;
      const selected = conflict.stages.get(stage);
      if (!selected) {
        throw new GitError(
          `The ${resolution.choice} side does not contain this path.`,
          'invalid-resolution'
        );
      }
      if (selected.mode === '160000') {
        throw new GitError(
          'Submodule conflicts must be resolved with external Git.',
          'unsupported-conflict'
        );
      }
      await clearConflictPaths(directory, detail.relatedPaths);
      await runGit(directory, [
        'update-index',
        '--add',
        '--cacheinfo',
        selected.mode,
        selected.oid,
        selected.path,
      ]);
      await runGit(directory, ['checkout-index', '--force', '--', selected.path]);
    }
    return mergeStateFromGit(directory);
  });
}

async function clearConflictPaths(directory: string, relativePaths: string[]): Promise<void> {
  for (const relativePath of relativePaths) resolveWithin(directory, relativePath);
  await runGit(directory, ['rm', '-f', '--ignore-unmatch', '--', ...relativePaths]);
}

export async function gitAbortMerge(directoryPath: string): Promise<{ aborted: true }> {
  const directory = ensureDirectoryAllowed(directoryPath);
  return withGitLock(directory, async () => {
    const state = await mergeStateFromGit(directory);
    if (state.phase !== 'conflicted' && state.phase !== 'ready-to-commit') {
      throw new GitError('There is no merge to abort.', 'no-merge');
    }
    await runGit(directory, ['merge', '--abort']);
    return { aborted: true };
  });
}

export async function gitCompleteMerge(
  directoryPath: string,
  message: string
): Promise<{ sha: string; abbreviatedSha: string }> {
  const directory = ensureDirectoryAllowed(directoryPath);
  if (!message.trim() || message.length > 5000) {
    throw new GitError('Enter a merge commit message.', 'invalid-input');
  }
  return withGitLock(directory, async () => {
    const state = await mergeStateFromGit(directory);
    if (state.phase !== 'ready-to-commit') {
      throw new GitError('Resolve every conflict before committing the merge.', 'merge-not-ready');
    }
    try {
      await loadCollectionDirectory(directory);
    } catch (error) {
      throw new GitError(
        `The resolved OpenCollection workspace is invalid: ${(error as Error).message}`,
        'invalid-workspace'
      );
    }
    await runGit(directory, ['commit', '-m', message.trim()]);
    const sha = (await runGit(directory, ['rev-parse', 'HEAD'])).trim();
    return { sha, abbreviatedSha: sha.slice(0, 7) };
  });
}

async function mergeStateFromGit(directory: string): Promise<GitMergeState> {
  const branch = (await runGit(directory, ['branch', '--show-current'])).trim() || null;
  const mergeHead = await optionalRef(directory, 'MERGE_HEAD');
  if (mergeHead) {
    const conflicts = await readConflicts(directory);
    const suggestedMessage = await readMergeMessage(directory);
    if (conflicts.length > 0) {
      if (!branch) throw new GitError('An active merge has a detached HEAD.', 'detached-head');
      return {
        phase: 'conflicted',
        branch,
        mergeHead,
        conflicts: conflicts.map((item) => item.summary),
        suggestedMessage,
      };
    }
    if (!branch) throw new GitError('An active merge has a detached HEAD.', 'detached-head');
    return { phase: 'ready-to-commit', branch, mergeHead, suggestedMessage };
  }

  const operation = await otherOperation(directory);
  if (operation) return { phase: 'blocked', branch, operation };
  const dirty = (await runGit(directory, ['status', '--porcelain=v2'])).trim().length > 0;
  return { phase: 'idle', branch, dirty };
}

async function currentConflict(directory: string, conflictId: string): Promise<ConflictRecord> {
  const conflict = (await readConflicts(directory)).find((item) => item.summary.id === conflictId);
  if (!conflict) {
    throw new GitError(
      'This conflict changed or was already resolved. Refresh and try again.',
      'stale-conflict'
    );
  }
  return conflict;
}

async function readConflicts(directory: string): Promise<ConflictRecord[]> {
  const raw = await runGit(directory, ['ls-files', '-u', '-z']);
  const paths = new Map<string, Map<1 | 2 | 3, IndexStage>>();
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const metadata = record.slice(0, tab).split(' ');
    const mode = metadata[0];
    const oid = metadata[1];
    const stage = Number(metadata[2]);
    const filePath = record.slice(tab + 1);
    if (!mode || !oid || (stage !== 1 && stage !== 2 && stage !== 3) || !filePath) continue;
    const stages = paths.get(filePath) ?? new Map<1 | 2 | 3, IndexStage>();
    stages.set(stage, { mode, oid, stage, path: filePath });
    paths.set(filePath, stages);
  }

  const conflicts: ConflictRecord[] = [];
  for (const groupedPaths of groupRenamePaths(paths)) {
    const stages = new Map<1 | 2 | 3, IndexStage>();
    for (const grouped of groupedPaths) {
      for (const [stage, entry] of grouped) stages.set(stage, entry);
    }
    const relatedPaths = [...new Set([...stages.values()].map((stage) => stage.path))].sort();
    const filePath = stages.get(2)?.path ?? stages.get(3)?.path ?? stages.get(1)?.path;
    if (!filePath) continue;
    const identity = [...stages.values()]
      .sort((left, right) => left.stage - right.stage)
      .map(({ mode, oid, stage, path: stagePath }) => [mode, oid, stage, stagePath]);
    const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const base = stages.has(1);
    const local = stages.has(2);
    const incoming = stages.has(3);
    const mode = stages.get(2)?.mode ?? stages.get(3)?.mode ?? stages.get(1)?.mode;
    conflicts.push({
      stages,
      summary: {
        id,
        path: filePath,
        relatedPaths,
        status:
          relatedPaths.length > 1
            ? 'rename'
            : !base && local && incoming
              ? 'both-added'
              : base && !local && incoming
                ? 'deleted-by-local'
                : base && local && !incoming
                  ? 'deleted-by-incoming'
                  : base && local && incoming
                    ? 'both-modified'
                    : 'unknown',
        kind: mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink' : 'text',
      },
    });
  }
  return conflicts.sort((left, right) => left.summary.path.localeCompare(right.summary.path));
}

async function conflictDetail(
  directory: string,
  conflict: ConflictRecord
): Promise<GitMergeConflictDetail> {
  const [base, local, incoming] = await Promise.all([
    readSide(directory, conflict.stages.get(1)),
    readSide(directory, conflict.stages.get(2)),
    readSide(directory, conflict.stages.get(3)),
  ]);
  const populated = [base, local, incoming].filter((side) => side.present);
  const oversized = populated.some((side) => side.content === undefined);
  const binary = populated.some((side) => side.content?.includes('\0'));
  const special = conflict.summary.kind === 'symlink' || conflict.summary.kind === 'submodule';
  const candidates = populated.flatMap((side) =>
    side.content === undefined ? [] : [side.content]
  );
  const openCollectionKind = detectOpenCollectionMergeFile(conflict.summary.path, candidates);

  let strategy: GitMergeConflictDetail['strategy'];
  let structured: GitMergeConflictDetail['structured'];
  let proposedContent: string | undefined;
  if (conflict.summary.kind === 'submodule') strategy = 'unsupported';
  else if (special || oversized || binary) strategy = 'choice-only';
  else if (
    openCollectionKind &&
    base.content !== undefined &&
    local.content !== undefined &&
    incoming.content !== undefined
  ) {
    const merge = createStructuredMerge(
      parseOpenCollectionMergeFile(conflict.summary.path, base.content, openCollectionKind),
      parseOpenCollectionMergeFile(conflict.summary.path, local.content, openCollectionKind),
      parseOpenCollectionMergeFile(conflict.summary.path, incoming.content, openCollectionKind)
    );
    strategy = 'structured';
    structured = merge;
    proposedContent = serializeOpenCollectionMergeFile(merge.result);
  } else {
    strategy = 'text';
    proposedContent = local.content ?? incoming.content ?? base.content ?? '';
  }

  return {
    ...conflict.summary,
    kind: special
      ? conflict.summary.kind
      : oversized
        ? 'oversized'
        : binary
          ? 'binary'
          : conflict.summary.kind,
    ...(openCollectionKind ? { openCollectionKind } : {}),
    strategy,
    base,
    local,
    incoming,
    ...(proposedContent !== undefined ? { proposedContent } : {}),
    ...(structured ? { structured } : {}),
  };
}

function groupRenamePaths(
  paths: Map<string, Map<1 | 2 | 3, IndexStage>>
): Array<Array<Map<1 | 2 | 3, IndexStage>>> {
  const groups = [...paths.values()].map((stages) => [stages]);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
        const left = groups[leftIndex]!;
        const right = groups[rightIndex]!;
        const leftStages = new Set(left.flatMap((item) => [...item.keys()]));
        const rightStages = new Set(right.flatMap((item) => [...item.keys()]));
        if ([...leftStages].some((stage) => rightStages.has(stage))) continue;
        const leftOids = new Set(
          left.flatMap((item) => [...item.values()].map((stage) => stage.oid))
        );
        const sharesObject = right.some((item) =>
          [...item.values()].some((stage) => leftOids.has(stage.oid))
        );
        if (!sharesObject) continue;
        left.push(...right);
        groups.splice(rightIndex, 1);
        changed = true;
        break outer;
      }
    }
  }
  return groups;
}

async function readSide(
  directory: string,
  stage: IndexStage | undefined
): Promise<GitConflictSide> {
  if (!stage) return { present: false };
  if (stage.mode === '160000') {
    return { present: true, oid: stage.oid, mode: stage.mode };
  }
  const size = Number((await runGit(directory, ['cat-file', '-s', stage.oid])).trim());
  if (!Number.isFinite(size) || size > MAX_CONFLICT_BLOB_BYTES) {
    return { present: true, oid: stage.oid, mode: stage.mode };
  }
  const content = await runGit(directory, ['cat-file', 'blob', stage.oid]);
  return { present: true, oid: stage.oid, mode: stage.mode, content };
}

async function optionalRef(directory: string, ref: string): Promise<string | null> {
  try {
    return (await runGit(directory, ['rev-parse', '--verify', '-q', ref])).trim() || null;
  } catch {
    return null;
  }
}

async function otherOperation(
  directory: string
): Promise<'rebase' | 'cherry-pick' | 'revert' | 'unknown' | null> {
  if (await optionalRef(directory, 'CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (await optionalRef(directory, 'REVERT_HEAD')) return 'revert';
  const rebaseMerge = (await runGit(directory, ['rev-parse', '--git-path', 'rebase-merge'])).trim();
  const rebaseApply = (await runGit(directory, ['rev-parse', '--git-path', 'rebase-apply'])).trim();
  if (
    existsSync(path.resolve(directory, rebaseMerge)) ||
    existsSync(path.resolve(directory, rebaseApply))
  ) {
    return 'rebase';
  }
  return null;
}

async function readMergeMessage(directory: string): Promise<string> {
  const relative = (await runGit(directory, ['rev-parse', '--git-path', 'MERGE_MSG'])).trim();
  try {
    return (await readFile(path.resolve(directory, relative), 'utf8')).slice(0, 5000).trim();
  } catch {
    return 'Merge branch';
  }
}

async function safeWriteConflictFile(
  directory: string,
  relativePath: string,
  content: string
): Promise<void> {
  const target = resolveWithin(directory, relativePath);
  const realRoot = await realpath(directory);
  let current = path.dirname(target);
  const segments: string[] = [];
  while (current !== directory && current !== path.dirname(current)) {
    segments.unshift(path.basename(current));
    current = path.dirname(current);
  }
  let checked = directory;
  for (const segment of segments) {
    checked = path.join(checked, segment);
    const stat = await lstat(checked);
    if (stat.isSymbolicLink())
      throw new GitError('Refusing to write through a symbolic link.', 'forbidden');
    const real = await realpath(checked);
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
      throw new GitError('Resolved path escapes the collection directory.', 'forbidden');
    }
  }
  const temporary = path.join(path.dirname(target), `.restura-merge-${process.pid}-${Date.now()}`);
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
