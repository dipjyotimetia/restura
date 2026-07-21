import {
  Check,
  GitBranch as GitBranchIcon,
  GitCommit as GitCommitIcon,
  RefreshCw,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useGit } from '@/hooks/useGit';
import { cn } from '@/lib/shared/utils';

interface GitDialogProps {
  collectionName: string;
  directoryPath: string | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Git collaboration for a registered file-backed collection. Git credentials
 * stay with system Git (SSH agent / credential manager), never in Restura.
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
  } = useGit(open ? directoryPath : null);
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);

  const changedFiles = useMemo(() => status?.files ?? [], [status]);

  const localBranches = branches.filter((b) => !b.isRemote);
  const stagedFiles = changedFiles.filter((file) => file.staged !== '.' && file.staged !== '?');
  const unstagedFiles = changedFiles.filter((file) => file.staged === '?' || file.unstaged !== '.');
  const currentBranch = localBranches.find((branch) => branch.isCurrent);

  const handleCommit = async () => {
    if (!message.trim() || stagedFiles.length === 0) return;
    setBusy(true);
    const err = await commit(message.trim());
    setBusy(false);
    if (err) {
      toast.error(`Commit failed: ${err}`);
    } else {
      toast.success('Committed');
      setMessage('');
    }
  };

  const handleFileAction = async (action: 'stage' | 'unstage' | 'discard', filePath: string) => {
    setBusy(true);
    const err =
      action === 'stage'
        ? await stage([filePath])
        : action === 'unstage'
          ? await unstage([filePath])
          : await discard([filePath]);
    setBusy(false);
    if (err) toast.error(`${action} failed: ${err}`);
    else if (action === 'discard') toast.success('Discarded local change');
  };

  const handleDiff = async (filePath: string, staged: boolean) => {
    setBusy(true);
    const result = await diff(filePath, staged);
    setBusy(false);
    setDiffText(result ?? 'No diff available.');
  };

  const handleSync = async (action: 'fetch' | 'pull' | 'push') => {
    setBusy(true);
    const err =
      action === 'fetch' ? await fetch() : action === 'pull' ? await pull() : await push();
    setBusy(false);
    if (err) toast.error(`${action} failed: ${err}`);
    else toast.success(action === 'push' ? 'Published branch' : `${action} complete`);
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sp-btn bg-sp-accent/15 text-sp-accent text-sp-12 font-medium hover:bg-sp-accent/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <GitBranchIcon className="h-3.5 w-3.5" />
                Initialize Git repository
              </button>
            </section>
          ) : (
            <>
              <section className="rounded-sp-btn border border-sp-line p-2.5 flex items-center gap-3 text-sp-12 font-mono">
                <span className="text-sp-text">{status?.branch ?? 'Detached HEAD'}</span>
                <span className="text-sp-dim">{currentBranch?.upstream ?? 'No upstream'}</span>
                <span className="ml-auto text-sp-muted">
                  ↑{status?.ahead ?? 0} ↓{status?.behind ?? 0}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSync('fetch')}
                  className="text-sp-accent disabled:opacity-50"
                >
                  Fetch
                </button>
                <button
                  type="button"
                  disabled={busy || !status?.clean}
                  onClick={() => void handleSync('pull')}
                  className="text-sp-accent disabled:opacity-50"
                >
                  Pull
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSync('push')}
                  className="text-sp-accent disabled:opacity-50"
                >
                  Push
                </button>
              </section>

              {/* Changes + commit */}
              <section className="space-y-2">
                <div className="sp-label">Changes ({changedFiles.length})</div>
                {changedFiles.length === 0 ? (
                  <p className="text-sp-12 text-sp-dim font-mono">Working tree clean</p>
                ) : (
                  <>
                    <ChangeGroup
                      title="Staged"
                      files={stagedFiles}
                      busy={busy}
                      onAction={handleFileAction}
                      onDiff={handleDiff}
                      onDiscard={setDiscardTarget}
                    />
                    <ChangeGroup
                      title="Unstaged"
                      files={unstagedFiles}
                      busy={busy}
                      onAction={handleFileAction}
                      onDiff={handleDiff}
                      onDiscard={setDiscardTarget}
                    />
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      aria-label="Commit message"
                      placeholder="Commit message"
                      rows={2}
                      className="w-full px-2.5 py-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong resize-none"
                    />
                    <button
                      type="button"
                      disabled={busy || !message.trim() || stagedFiles.length === 0}
                      onClick={handleCommit}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sp-btn bg-sp-accent/15 text-sp-accent text-sp-12 font-medium hover:bg-sp-accent/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <GitCommitIcon className="h-3.5 w-3.5" />
                      Commit index ({stagedFiles.length} file{stagedFiles.length === 1 ? '' : 's'})
                    </button>
                  </>
                )}
              </section>

              {diffText !== null && (
                <section className="space-y-2">
                  <div className="sp-label">File diff</div>
                  <pre className="max-h-56 overflow-auto rounded-sp-btn border border-sp-line p-2 text-sp-11-5 font-mono whitespace-pre-wrap">
                    {diffText}
                  </pre>
                </section>
              )}

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
                    aria-label="New branch name"
                    placeholder="new-branch-name"
                    className="flex-1 h-7 px-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong"
                  />
                  <button
                    type="button"
                    disabled={busy || !newBranch.trim()}
                    onClick={handleCreateBranch}
                    className="px-2.5 py-1.5 rounded-sp-btn text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors disabled:opacity-50"
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
      <ConfirmDialog
        open={discardTarget !== null}
        onOpenChange={(value) => !value && setDiscardTarget(null)}
        title="Discard local change?"
        description="This restores the selected file from the last commit or removes an untracked file. This cannot be undone."
        confirmText="Discard"
        variant="destructive"
        onConfirm={() => {
          if (discardTarget) void handleFileAction('discard', discardTarget);
          setDiscardTarget(null);
        }}
      />
    </Dialog>
  );
}

function ChangeGroup({
  title,
  files,
  busy,
  onAction,
  onDiff,
  onDiscard,
}: {
  title: string;
  files: Array<{ path: string; staged: string; unstaged: string }>;
  busy: boolean;
  onAction: (action: 'stage' | 'unstage', filePath: string) => Promise<void>;
  onDiff: (filePath: string, staged: boolean) => Promise<void>;
  onDiscard: (filePath: string) => void;
}) {
  if (files.length === 0) return null;
  const staged = title === 'Staged';
  return (
    <div className="rounded-sp-btn border border-sp-line divide-y divide-sp-line">
      <div className="px-2.5 py-1 text-sp-11-5 text-sp-dim font-mono">{title}</div>
      {files.map((file) => (
        <div key={`${title}:${file.path}`} className="flex items-center gap-2 px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => void onDiff(file.path, staged)}
            className="font-mono text-sp-12 text-sp-text truncate text-left flex-1"
          >
            {file.path}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onAction(staged ? 'unstage' : 'stage', file.path)}
            className="text-sp-11-5 text-sp-accent disabled:opacity-50"
          >
            {staged ? 'Unstage' : 'Stage'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDiscard(file.path)}
            className="text-sp-11-5 text-red-400 disabled:opacity-50"
          >
            Discard
          </button>
        </div>
      ))}
    </div>
  );
}

export default GitDialog;
