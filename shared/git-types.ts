/**
 * Git data shapes shared between the Electron main-process git handler
 * (electron/main/handlers/git-handler.ts) and the renderer hook
 * (src/hooks/useGit.ts). Defined once here so the IPC producer and consumer
 * can't drift.
 */

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
}

export interface GitCommit {
  sha: string;
  abbreviatedSha: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
}
