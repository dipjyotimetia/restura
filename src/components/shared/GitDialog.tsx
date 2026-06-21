import { useEffect, useMemo, useState } from 'react';
import {
  GitBranch as GitBranchIcon,
  Check,
  RefreshCw,
  GitCommit as GitCommitIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useGit } from '@/hooks/useGit';
import { cn } from '@/lib/shared/utils';

interface GitDialogProps {
  collectionName: string;
  directoryPath: string | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Local git operations for a file-backed collection: review changes, stage +
 * commit, and switch / create branches. Remote (push/pull) is intentionally
 * absent — that needs a credential model and lands later. Desktop-only.
 */
export function GitDialog({ collectionName, directoryPath, open, onClose }: GitDialogProps) {
  const {
    status,
    branches,
    log,
    loading,
    error,
    notARepo,
    refresh,
    init,
    commit,
    createBranch,
    checkout,
  } = useGit(open ? directoryPath : null);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);

  const changedFiles = useMemo(() => status?.files ?? [], [status]);

  // Default to staging every changed file when the list refreshes.
  useEffect(() => {
    setSelected(new Set(changedFiles.map((f) => f.path)));
  }, [changedFiles]);

  const localBranches = branches.filter((b) => !b.isRemote);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleCommit = async () => {
    if (!message.trim() || selected.size === 0) return;
    setBusy(true);
    const err = await commit(message.trim(), [...selected]);
    setBusy(false);
    if (err) {
      toast.error(`Commit failed: ${err}`);
    } else {
      toast.success('Committed');
      setMessage('');
    }
  };

  const handleCreateBranch = async () => {
    const name = newBranch.trim();
    if (!name) return;
    setBusy(true);
    const err = await createBranch(name);
    setBusy(false);
    if (err) toast.error(`Create branch failed: ${err}`);
    else {
      toast.success(`Switched to ${name}`);
      setNewBranch('');
    }
  };

  const handleCheckout = async (name: string) => {
    setBusy(true);
    const err = await checkout(name);
    setBusy(false);
    if (err) toast.error(`Checkout failed: ${err}`);
    else toast.success(`Switched to ${name}`);
  };

  const handleInit = async () => {
    setBusy(true);
    const err = await init();
    setBusy(false);
    if (err) toast.error(`Init failed: ${err}`);
    else toast.success('Initialized Git repository');
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl h-[80vh] flex flex-col p-0 gap-0">
        {/* pr-14 reserves the top-right corner for DialogContent's absolute close button */}
        <DialogHeader className="py-3 pl-4 pr-14 border-b border-sp-line flex-row items-center justify-between space-y-0">
          <div>
            <DialogTitle className="font-mono text-sm tracking-wide flex items-center gap-2">
              <GitBranchIcon className="h-4 w-4" /> {collectionName}
              {status?.branch && <span className="text-sp-accent">· {status.branch}</span>}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Local git operations for this collection
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh"
            className="inline-flex items-center justify-center size-7 rounded-sp-btn text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-5">
          {error && <p className="text-sp-12 text-amber-500 font-mono">{error}</p>}

          {notARepo ? (
            /* Directory isn't a git repo yet — offer to initialise it (the local
               "spinup" path; clone-from-remote is deferred). */
            <section className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <GitBranchIcon className="h-8 w-8 text-sp-dim" />
              <p className="text-sp-12 text-sp-muted font-mono max-w-sm">
                This collection folder isn’t a Git repository yet. Initialize one to start tracking
                changes, committing, and branching.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={handleInit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sp-btn bg-sp-accent/15 text-sp-accent text-sp-12 font-medium hover:bg-sp-accent/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <GitBranchIcon className="h-3.5 w-3.5" />
                Initialize Git repository
              </button>
            </section>
          ) : (
            <>
              {/* Changes + commit */}
              <section className="space-y-2">
                <div className="sp-label">Changes ({changedFiles.length})</div>
                {changedFiles.length === 0 ? (
                  <p className="text-sp-12 text-sp-dim font-mono">Working tree clean</p>
                ) : (
                  <>
                    <div className="rounded-sp-btn border border-sp-line divide-y divide-sp-line max-h-44 overflow-auto">
                      {changedFiles.map((f) => (
                        <label
                          key={f.path}
                          className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-sp-hover"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(f.path)}
                            onChange={() => toggle(f.path)}
                          />
                          <span className="font-mono text-sp-11-5 text-sp-dim w-6 uppercase">
                            {(f.staged !== '.' && f.staged) ||
                              (f.unstaged !== '.' && f.unstaged) ||
                              '?'}
                          </span>
                          <span className="font-mono text-sp-12 text-sp-text truncate">
                            {f.path}
                          </span>
                        </label>
                      ))}
                    </div>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Commit message"
                      rows={2}
                      className="w-full px-2.5 py-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong resize-none"
                    />
                    <button
                      type="button"
                      disabled={busy || !message.trim() || selected.size === 0}
                      onClick={handleCommit}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sp-btn bg-sp-accent/15 text-sp-accent text-sp-12 font-medium hover:bg-sp-accent/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <GitCommitIcon className="h-3.5 w-3.5" />
                      Commit {selected.size} file{selected.size === 1 ? '' : 's'}
                    </button>
                  </>
                )}
              </section>

              {/* Branches */}
              <section className="space-y-2">
                <div className="sp-label">Branches</div>
                <div className="rounded-sp-btn border border-sp-line divide-y divide-sp-line max-h-40 overflow-auto">
                  {localBranches.map((b) => (
                    <button
                      key={b.name}
                      type="button"
                      disabled={busy || b.isCurrent}
                      onClick={() => handleCheckout(b.name)}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-sp-hover disabled:cursor-default"
                    >
                      {b.isCurrent ? (
                        <Check className="h-3.5 w-3.5 text-sp-accent shrink-0" />
                      ) : (
                        <span className="w-3.5 shrink-0" />
                      )}
                      <span
                        className={cn(
                          'font-mono text-sp-12 truncate',
                          b.isCurrent ? 'text-sp-text' : 'text-sp-muted'
                        )}
                      >
                        {b.name}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    placeholder="new-branch-name"
                    className="flex-1 h-7 px-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong"
                  />
                  <button
                    type="button"
                    disabled={busy || !newBranch.trim()}
                    onClick={handleCreateBranch}
                    className="px-2.5 py-1.5 rounded-sp-btn text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors disabled:opacity-40"
                  >
                    Create
                  </button>
                </div>
              </section>

              {/* Recent commits */}
              <section className="space-y-2">
                <div className="sp-label">Recent commits</div>
                <div className="space-y-1">
                  {log.map((c) => (
                    <div key={c.sha} className="flex items-baseline gap-2 text-sp-12">
                      <span className="font-mono text-sp-dim">{c.abbreviatedSha}</span>
                      <span className="text-sp-text truncate">{c.subject}</span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default GitDialog;
