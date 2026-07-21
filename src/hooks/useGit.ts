import type { GitBranch, GitCommit, GitStatus, GitStatusFile } from '@shared/git-types';
import { useCallback, useEffect, useState } from 'react';
import { getElectronAPI } from '@/lib/shared/platform';
import { loadCollectionFromDirectory } from '@/store/useFileCollectionStore';

export type { GitBranch, GitCommit, GitStatus, GitStatusFile };

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
 * collection directory. Read ops populate state; writes refresh afterwards.
 * Desktop-only — `api.git` is undefined on web,
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
      // The main process tags the "outside a repo" failure with a stable code,
      // so we branch on that instead of matching git's (localized) message.
      const notARepo = !statusRes.ok && statusRes.code === 'not-a-repo';
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

  const stage = useCallback(
    async (filePaths: string[]): Promise<string | null> => {
      const api = getElectronAPI();
      if (!api?.git || !directoryPath) return 'Git unavailable';
      const res = await api.git.add(directoryPath, filePaths);
      await refresh();
      return res.ok ? null : res.error;
    },
    [directoryPath, refresh]
  );

  const unstage = useCallback(
    async (filePaths: string[]): Promise<string | null> => {
      const api = getElectronAPI();
      if (!api?.git || !directoryPath) return 'Git unavailable';
      const res = await api.git.unstage(directoryPath, filePaths);
      await refresh();
      return res.ok ? null : res.error;
    },
    [directoryPath, refresh]
  );

  const discard = useCallback(
    async (filePaths: string[]): Promise<string | null> => {
      const api = getElectronAPI();
      if (!api?.git || !directoryPath) return 'Git unavailable';
      const res = await api.git.discard(directoryPath, filePaths);
      await refresh();
      return res.ok ? null : res.error;
    },
    [directoryPath, refresh]
  );

  const diff = useCallback(
    async (filePath: string, staged = false): Promise<string | null> => {
      const api = getElectronAPI();
      if (!api?.git || !directoryPath) return 'Git unavailable';
      const res = await api.git.diff(directoryPath, filePath, staged);
      return res.ok ? res.diff : res.error;
    },
    [directoryPath]
  );

  const commit = useCallback(
    async (message: string): Promise<string | null> => {
      const api = getElectronAPI();
      if (!api?.git || !directoryPath) return 'Git unavailable';
      // Commit exactly what is already in the index. The dialog stages files
      // explicitly, so this never sweeps unstaged work into a commit.
      const res = await api.git.commit(directoryPath, message);
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
        // Best-effort: the branch already switched, so a reload failure must not
        // turn a successful checkout into an error (or escape and stick the
        // caller's spinner). `refresh()` below re-reads git state regardless.
        await loadCollectionFromDirectory(directoryPath).catch(() => null);
      }
      await refresh();
      return res.ok ? null : res.error;
    },
    [directoryPath, refresh]
  );

  const reloadCollection = useCallback(async () => {
    if (directoryPath) await loadCollectionFromDirectory(directoryPath).catch(() => null);
  }, [directoryPath]);

  const fetch = useCallback(async (): Promise<string | null> => {
    const api = getElectronAPI();
    if (!api?.git || !directoryPath) return 'Git unavailable';
    const res = await api.git.fetch(directoryPath);
    await refresh();
    return res.ok ? null : res.error;
  }, [directoryPath, refresh]);

  const pull = useCallback(async (): Promise<string | null> => {
    const api = getElectronAPI();
    if (!api?.git || !directoryPath) return 'Git unavailable';
    const res = await api.git.pull(directoryPath);
    if (res.ok) await reloadCollection();
    await refresh();
    return res.ok ? null : res.error;
  }, [directoryPath, refresh, reloadCollection]);

  const push = useCallback(async (): Promise<string | null> => {
    const api = getElectronAPI();
    if (!api?.git || !directoryPath) return 'Git unavailable';
    const res = await api.git.push(directoryPath);
    await refresh();
    return res.ok ? null : res.error;
  }, [directoryPath, refresh]);

  return {
    ...state,
    refresh,
    init,
    stage,
    unstage,
    discard,
    diff,
    commit,
    createBranch,
    checkout,
    fetch,
    pull,
    push,
  };
}
