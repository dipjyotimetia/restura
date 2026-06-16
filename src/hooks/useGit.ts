import { useCallback, useEffect, useState } from 'react';
import { getElectronAPI } from '@/lib/shared/platform';
import { loadCollectionFromDirectory } from '@/store/useFileCollectionStore';

/** git's "fatal: not a git repository …" surfaced when a dir isn't yet a repo. */
const NOT_A_REPO_RE = /not a git repository/i;

export interface GitStatusFile {
  path: string;
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

interface GitState {
  status: GitStatus | null;
  branches: GitBranch[];
  log: GitCommit[];
  loading: boolean;
  error: string | null;
  /** True when the directory isn't a git repo yet — offer `init()`. */
  notARepo: boolean;
}

/**
 * Renderer wrapper over the Electron git IPC for a single (allow-listed)
 * collection directory. Read ops populate state; write ops (stage/commit/
 * branch) refresh afterwards. Desktop-only — `api.git` is undefined on web,
 * surfaced as an error rather than throwing.
 */
export function useGit(directoryPath: string | null) {
  const [state, setState] = useState<GitState>({
    status: null,
    branches: [],
    log: [],
    loading: false,
    error: null,
    notARepo: false,
  });

  const refresh = useCallback(async () => {
    const api = getElectronAPI();
    if (!api?.git || !directoryPath) {
      setState((s) => ({ ...s, error: 'Git is only available in the desktop app' }));
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [statusRes, branchRes, logRes] = await Promise.all([
        api.git.status(directoryPath),
        api.git.branchList(directoryPath),
        api.git.log(directoryPath, 20),
      ]);
      const statusError = statusRes.ok ? null : statusRes.error;
      const notARepo = statusError != null && NOT_A_REPO_RE.test(statusError);
      setState({
        status: statusRes.ok ? statusRes.status : null,
        branches: branchRes.ok ? branchRes.branches : [],
        log: logRes.ok ? logRes.commits : [],
        loading: false,
        // When the dir simply isn't a repo yet, surface that via `notARepo` (the
        // UI offers Init) rather than as a raw error banner.
        error: notARepo ? null : statusError,
        notARepo,
      });
    } catch (err) {
      // An IPC invoke can reject during teardown / missing handler — never leave
      // the spinner stuck.
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Git operation failed',
      }));
    }
  }, [directoryPath]);

  useEffect(() => {
    if (directoryPath) void refresh();
  }, [directoryPath, refresh]);

  const init = useCallback(async (): Promise<string | null> => {
    const api = getElectronAPI();
    if (!api?.git || !directoryPath) return 'Git unavailable';
    const res = await api.git.init(directoryPath);
    await refresh();
    return res.ok ? null : res.error;
  }, [directoryPath, refresh]);

  const commit = useCallback(
    async (message: string, filePaths: string[]): Promise<string | null> => {
      const api = getElectronAPI();
      if (!api?.git || !directoryPath) return 'Git unavailable';
      if (filePaths.length > 0) {
        const staged = await api.git.add(directoryPath, filePaths);
        if (!staged.ok) return staged.error;
      }
      // Scope the commit to exactly the selected files so anything staged
      // outside this dialog isn't committed too.
      const res = await api.git.commit(
        directoryPath,
        message,
        filePaths.length > 0 ? { paths: filePaths } : undefined
      );
      await refresh();
      return res.ok ? null : res.error;
    },
    [directoryPath, refresh]
  );

  const createBranch = useCallback(
    async (name: string): Promise<string | null> => {
      const api = getElectronAPI();
      if (!api?.git || !directoryPath) return 'Git unavailable';
      const res = await api.git.createBranch(directoryPath, name);
      await refresh();
      return res.ok ? null : res.error;
    },
    [directoryPath, refresh]
  );

  const checkout = useCallback(
    async (name: string): Promise<string | null> => {
      const api = getElectronAPI();
      if (!api?.git || !directoryPath) return 'Git unavailable';
      const res = await api.git.checkoutBranch(directoryPath, name);
      if (res.ok) {
        // A branch switch rewrites the collection files on disk. Reload from
        // disk explicitly so the in-memory collection reflects the new branch —
        // the chokidar watcher is best-effort and doesn't drive a reload.
        await loadCollectionFromDirectory(directoryPath);
      }
      await refresh();
      return res.ok ? null : res.error;
    },
    [directoryPath, refresh]
  );

  return { ...state, refresh, init, commit, createBranch, checkout };
}
