import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import type { CollectionRunResult, CollectionRequestResult } from '../lib/collectionRunner';
import { PROTOCOL_LABELS, PROTOCOL_COLORS } from '@/lib/shared/constants';
import { cn } from '@/lib/shared/utils';

function StatusIcon({ status }: { status: CollectionRequestResult['status'] }) {
  if (status === 'success')
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  return <MinusCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
}

function RequestRow({ r }: { r: CollectionRequestResult }) {
  const label = PROTOCOL_LABELS[r.protocol] ?? r.protocol.toUpperCase();
  const color = PROTOCOL_COLORS[r.protocol];
  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <StatusIcon status={r.status} />
        <span
          className={cn(
            'shrink-0 rounded px-1 py-0.5 text-[9px] font-mono font-medium leading-none',
            color ?? 'bg-muted text-muted-foreground border border-border'
          )}
        >
          {label}
        </span>
        <span className="flex-1 truncate">{r.itemName}</span>
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
          {r.durationMs != null ? `${r.durationMs}ms` : ''}
        </span>
        {r.httpStatus != null && (
          <span
            className={cn(
              'font-mono text-[10px] font-bold px-1 py-0.5 rounded',
              r.status === 'success'
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-red-500/10 text-red-600 dark:text-red-400'
            )}
          >
            {r.httpStatus}
          </span>
        )}
      </div>
      {r.skippedReason && (
        <p className="pl-6 text-[10px] text-amber-600 dark:text-amber-400">{r.skippedReason}</p>
      )}
      {r.error && <p className="pl-6 text-[10px] text-red-600 dark:text-red-400">{r.error}</p>}
      {r.assertions.length > 0 && (
        <div className="pl-6 space-y-0.5">
          {r.assertions.map((a, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px]">
              {a.passed ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
              ) : (
                <XCircle className="h-3 w-3 text-red-500 shrink-0" />
              )}
              <span
                className={cn(
                  a.passed ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400'
                )}
              >
                {a.name}
                {a.error ? ` — ${a.error}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CollectionRunDetail({
  run,
  onClose,
}: {
  run: CollectionRunResult | null;
  onClose: () => void;
}) {
  if (!run) return null;

  // Group by iteration so data-driven runs read clearly.
  const byIteration = new Map<number, CollectionRequestResult[]>();
  for (const r of run.requests) {
    const list = byIteration.get(r.iteration) ?? [];
    list.push(r);
    byIteration.set(r.iteration, list);
  }
  const iterations = [...byIteration.keys()].sort((a, b) => a - b);
  const showIterationHeaders = run.iterations > 1;

  return (
    <Dialog
      open={run !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span>{run.scopeName}</span>
            <span className="text-xs font-mono font-normal text-muted-foreground">
              <span className="text-emerald-600 dark:text-emerald-400">
                {run.summary.passed} passed
              </span>
              {' · '}
              <span className="text-red-600 dark:text-red-400">{run.summary.failed} failed</span>
              {run.summary.skipped > 0 && (
                <>
                  {' · '}
                  <span className="text-amber-600 dark:text-amber-400">
                    {run.summary.skipped} skipped
                  </span>
                </>
              )}
              {' · '}
              {run.durationMs}ms
            </span>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="flex-1 border rounded-md">
          {iterations.map((iter) => (
            <div key={iter}>
              {showIterationHeaders && (
                <div className="sticky top-0 bg-muted/80 backdrop-blur px-3 py-1 text-[10px] font-mono font-semibold uppercase tracking-wider text-muted-foreground">
                  Iteration {iter + 1}
                </div>
              )}
              <div className="divide-y divide-border/40">
                {byIteration.get(iter)!.map((r, i) => (
                  <RequestRow key={`${r.itemId}-${i}`} r={r} />
                ))}
              </div>
            </div>
          ))}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
