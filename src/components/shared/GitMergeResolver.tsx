import { applyStructuredChoices, type StructuredChoice } from '@shared/git-merge';
import type {
  GitConflictResolution,
  GitMergeConflictDetail,
  GitMergeState,
} from '@shared/git-types';
import { serializeOpenCollectionMergeFile } from '@shared/opencollection/merge-file';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/shared/utils';

type ConflictedState = Extract<GitMergeState, { phase: 'conflicted' }>;

interface GitMergeResolverProps {
  state: ConflictedState;
  busy: boolean;
  getConflict: (conflictId: string) => Promise<GitMergeConflictDetail | string>;
  resolveConflict: (resolution: GitConflictResolution) => Promise<string | null>;
  onBusyChange: (busy: boolean) => void;
}

export function GitMergeResolver({
  state,
  busy,
  getConflict,
  resolveConflict,
  onBusyChange,
}: GitMergeResolverProps) {
  const [detail, setDetail] = useState<GitMergeConflictDetail | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (detail && !state.conflicts.some((conflict) => conflict.id === detail.id)) {
      setDetail(null);
    }
  }, [detail, state.conflicts]);

  const selectConflict = async (conflictId: string) => {
    setLoadingId(conflictId);
    const result = await getConflict(conflictId);
    setLoadingId(null);
    if (typeof result === 'string') {
      toast.error(`Unable to read conflict: ${result}`);
      return;
    }
    setDetail(result);
  };

  const submit = async (resolution: GitConflictResolution) => {
    onBusyChange(true);
    const error = await resolveConflict(resolution);
    onBusyChange(false);
    if (error) toast.error(`Resolve failed: ${error}`);
    else {
      toast.success('Conflict resolved');
      setDetail(null);
    }
  };

  return (
    <section className="space-y-3 rounded-sp-btn border border-amber-500/30 bg-amber-500/5 p-3">
      <div>
        <div className="text-sp-12 font-medium text-amber-400">Merge interrupted</div>
        <p className="mt-1 text-sp-11-5 text-sp-muted">
          Resolve every file below. Restura reconstructs this list from Git’s index, so it remains
          available after closing and reopening the dialog.
        </p>
      </div>
      <div className="grid min-h-64 gap-3 md:grid-cols-[minmax(12rem,0.36fr)_minmax(0,1fr)]">
        <div className="space-y-1">
          {state.conflicts.map((conflict) => (
            <button
              key={conflict.id}
              type="button"
              disabled={busy || loadingId !== null}
              onClick={() => void selectConflict(conflict.id)}
              aria-label={`Resolve ${conflict.path}`}
              className={cn(
                'w-full rounded-sp-btn border px-2.5 py-2 text-left font-mono text-sp-11-5 transition-colors',
                detail?.id === conflict.id
                  ? 'border-sp-accent/50 bg-sp-accent/10 text-sp-text'
                  : 'border-sp-line text-sp-muted hover:bg-sp-hover'
              )}
            >
              <span className="block truncate">{conflict.path}</span>
              <span className="mt-0.5 block text-sp-dim">
                {conflict.kind} · {conflict.status}
              </span>
            </button>
          ))}
        </div>
        <div className="min-w-0">
          {detail ? (
            <ConflictEditor key={detail.id} detail={detail} busy={busy} onSubmit={submit} />
          ) : (
            <div className="flex h-full items-center justify-center rounded-sp-btn border border-dashed border-sp-line p-5 text-center text-sp-11-5 text-sp-dim">
              Select a conflicted file to inspect its base, local, and incoming versions.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ConflictEditor({
  detail,
  busy,
  onSubmit,
}: {
  detail: GitMergeConflictDetail;
  busy: boolean;
  onSubmit: (resolution: GitConflictResolution) => Promise<void>;
}) {
  if (detail.strategy === 'unsupported') {
    return (
      <div className="rounded-sp-btn border border-sp-line p-3 text-sp-12 text-sp-muted">
        Resolve this submodule with Git outside Restura, then refresh this dialog. Restura does not
        rewrite gitlinks.
      </div>
    );
  }

  if (detail.strategy === 'choice-only') {
    return (
      <div className="space-y-3 rounded-sp-btn border border-sp-line p-3">
        <div className="font-mono text-sp-12 text-sp-text">{detail.path}</div>
        <p className="text-sp-11-5 text-sp-muted">
          This {detail.kind} file cannot be edited safely here. Keep one complete Git stage or
          delete the path.
        </p>
        <ChoiceButtons detail={detail} busy={busy} onSubmit={onSubmit} />
      </div>
    );
  }

  if (detail.strategy === 'structured' && detail.structured) {
    return <StructuredConflictEditor detail={detail} busy={busy} onSubmit={onSubmit} />;
  }

  return <TextConflictEditor detail={detail} busy={busy} onSubmit={onSubmit} />;
}

function StructuredConflictEditor({
  detail,
  busy,
  onSubmit,
}: {
  detail: GitMergeConflictDetail;
  busy: boolean;
  onSubmit: (resolution: GitConflictResolution) => Promise<void>;
}) {
  const structured = detail.structured;
  const [choices, setChoices] = useState<Record<string, StructuredChoice>>({});
  const [content, setContent] = useState(detail.proposedContent ?? '');
  if (!structured) return null;
  const complete = structured.conflicts.every((conflict) => choices[conflict.path]);

  const choose = (path: string, choice: StructuredChoice) => {
    const next = { ...choices, [path]: choice };
    setChoices(next);
    if (structured.conflicts.every((conflict) => next[conflict.path])) {
      const document = applyStructuredChoices(structured, next);
      setContent(serializeOpenCollectionMergeFile(document));
    }
  };

  return (
    <div className="space-y-3">
      <div className="font-mono text-sp-12 text-sp-text">{detail.path}</div>
      {structured.conflicts.map((conflict) => (
        <div key={conflict.path} className="rounded-sp-btn border border-sp-line p-2.5">
          <div className="mb-2 font-mono text-sp-11-5 text-sp-accent">{conflict.path || '/'}</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {(['base', 'local', 'incoming'] as const).map((choice) => {
              const value = conflict[choice];
              return (
                <button
                  key={choice}
                  type="button"
                  disabled={busy || !value.present}
                  onClick={() => choose(conflict.path, choice)}
                  aria-label={`Use ${choice} for ${conflict.path || '/'}`}
                  className={cn(
                    'min-w-0 rounded-sp-btn border p-2 text-left text-sp-11-5 disabled:opacity-40',
                    choices[conflict.path] === choice
                      ? 'border-sp-accent bg-sp-accent/10'
                      : 'border-sp-line hover:bg-sp-hover'
                  )}
                >
                  <span className="block capitalize text-sp-muted">{choice}</span>
                  <code className="mt-1 block overflow-auto whitespace-pre-wrap text-sp-text">
                    {formatValue(value)}
                  </code>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        aria-label="Resolved file content"
        rows={9}
        className="w-full resize-y rounded-sp-btn border border-sp-line bg-sp-surface-lo p-2 font-mono text-sp-11-5 outline-none focus:border-sp-line-strong"
      />
      <button
        type="button"
        disabled={busy || !complete}
        onClick={() => void onSubmit({ conflictId: detail.id, kind: 'content', content })}
        className="rounded-sp-btn bg-sp-accent/15 px-3 py-1.5 text-sp-12 font-medium text-sp-accent disabled:opacity-50"
      >
        Resolve file
      </button>
    </div>
  );
}

function TextConflictEditor({
  detail,
  busy,
  onSubmit,
}: {
  detail: GitMergeConflictDetail;
  busy: boolean;
  onSubmit: (resolution: GitConflictResolution) => Promise<void>;
}) {
  const [content, setContent] = useState(detail.proposedContent ?? detail.local.content ?? '');
  return (
    <div className="space-y-3">
      <div className="font-mono text-sp-12 text-sp-text">{detail.path}</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Side title="Base" content={detail.base.content} present={detail.base.present} />
        <Side title="Local" content={detail.local.content} present={detail.local.present} />
        <Side
          title="Incoming"
          content={detail.incoming.content}
          present={detail.incoming.present}
        />
      </div>
      <label className="block text-sp-11-5 text-sp-muted" htmlFor="git-resolved-content">
        Resolved result
      </label>
      <textarea
        id="git-resolved-content"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={10}
        className="w-full resize-y rounded-sp-btn border border-sp-line bg-sp-surface-lo p-2 font-mono text-sp-11-5 outline-none focus:border-sp-line-strong"
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void onSubmit({ conflictId: detail.id, kind: 'content', content })}
        className="rounded-sp-btn bg-sp-accent/15 px-3 py-1.5 text-sp-12 font-medium text-sp-accent disabled:opacity-50"
      >
        Resolve file
      </button>
    </div>
  );
}

function Side({ title, content, present }: { title: string; content?: string; present: boolean }) {
  return (
    <div className="min-w-0 rounded-sp-btn border border-sp-line p-2">
      <div className="mb-1 text-sp-11-5 text-sp-muted">{title}</div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-sp-11-5 text-sp-text">
        {present ? (content ?? '(no preview)') : '(deleted)'}
      </pre>
    </div>
  );
}

function ChoiceButtons({
  detail,
  busy,
  onSubmit,
}: {
  detail: GitMergeConflictDetail;
  busy: boolean;
  onSubmit: (resolution: GitConflictResolution) => Promise<void>;
}) {
  const choices = [
    { key: 'base', label: 'Use base file', available: detail.base.present },
    { key: 'local', label: 'Use local file', available: detail.local.present },
    { key: 'incoming', label: 'Use incoming file', available: detail.incoming.present },
    { key: 'delete', label: 'Delete file', available: true },
  ] as const;
  return (
    <div className="flex flex-wrap gap-2">
      {choices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          disabled={busy || !choice.available}
          onClick={() =>
            void onSubmit({ conflictId: detail.id, kind: 'choice', choice: choice.key })
          }
          className="rounded-sp-btn border border-sp-line px-2.5 py-1.5 text-sp-11-5 text-sp-muted hover:bg-sp-hover disabled:opacity-40"
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

function formatValue(value: { present: false } | { present: true; value: unknown }): string {
  if (!value.present) return '(missing)';
  if (typeof value.value === 'string') return value.value;
  return JSON.stringify(value.value, null, 2);
}
