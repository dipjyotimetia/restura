/**
 * Git data shapes shared between the Electron main-process git handler
 * (electron/main/handlers/git-handler.ts) and the renderer hook
 * (src/hooks/useGit.ts). Defined once here so the IPC producer and consumer
 * can't drift.
 */

import type { StructuredMerge } from './git-merge';
import type { OpenCollectionMergeFileKind } from './opencollection/merge-file';

export interface GitStatusFile {
  path: string;
  /** Index status code from `git status --porcelain` (e.g. 'M', 'A', 'D', '?'). */
  staged: string;
  unstaged: string;
}

export interface GitStatus {
  files: GitStatusFile[];
  branch: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream?: string;
  /** Full commit object ID at the time the branch list was read. */
  oid?: string;
}

export interface GitCommit {
  sha: string;
  abbreviatedSha: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
}

export type GitMergeOperation = 'rebase' | 'cherry-pick' | 'revert' | 'unknown';

export interface GitMergeConflictSummary {
  id: string;
  path: string;
  relatedPaths: string[];
  status:
    | 'both-modified'
    | 'both-added'
    | 'deleted-by-local'
    | 'deleted-by-incoming'
    | 'rename'
    | 'unknown';
  kind: 'text' | 'binary' | 'oversized' | 'symlink' | 'submodule';
  openCollectionKind?: OpenCollectionMergeFileKind;
}

export type GitMergeState =
  | {
      phase: 'idle';
      branch: string | null;
      dirty: boolean;
    }
  | {
      phase: 'blocked';
      branch: string | null;
      operation: GitMergeOperation;
    }
  | {
      phase: 'conflicted';
      branch: string;
      mergeHead: string;
      conflicts: GitMergeConflictSummary[];
      suggestedMessage: string;
    }
  | {
      phase: 'ready-to-commit';
      branch: string;
      mergeHead: string;
      suggestedMessage: string;
    };

export type GitMergeOutcome =
  | { kind: 'fast-forward'; head: string }
  | { kind: 'conflicted'; state: Extract<GitMergeState, { phase: 'conflicted' }> }
  | { kind: 'ready-to-commit'; state: Extract<GitMergeState, { phase: 'ready-to-commit' }> };

export interface GitConflictSide {
  present: boolean;
  oid?: string;
  mode?: string;
  content?: string;
}

export interface GitMergeConflictDetail extends GitMergeConflictSummary {
  strategy: 'structured' | 'text' | 'choice-only' | 'unsupported';
  base: GitConflictSide;
  local: GitConflictSide;
  incoming: GitConflictSide;
  proposedContent?: string;
  structured?: StructuredMerge;
}

export type GitConflictResolution =
  | {
      conflictId: string;
      kind: 'content';
      content: string;
    }
  | {
      conflictId: string;
      kind: 'choice';
      choice: 'base' | 'local' | 'incoming' | 'delete';
    };
