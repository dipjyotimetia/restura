import { CheckCircle2, Download, MinusCircle, Play, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PROTOCOL_COLORS, PROTOCOL_LABELS } from '@/lib/shared/constants';
import { downloadBlob } from '@/lib/shared/file-utils';
import { cn } from '@/lib/shared/utils';
import {
  renderCollectionRunHtml,
  renderCollectionRunJson,
  renderCollectionRunJUnit,
} from '../lib/collectionRunExport';
import type { CollectionRequestResult, CollectionRunResult } from '../lib/collectionRunner';

function StatusIcon({ status }: { status: CollectionRequestResult['status'] }) {
  if (status === 'success')
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  return <MinusCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
}

function RequestRow({ r, onRerun }: { r: CollectionRequestResult; onRerun?: () => void }) {
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
      {r.evidence && (
        <div className="pl-6 space-y-1 text-[10px] text-muted-foreground">
          <p>
            {r.evidence.unavailable
              ? r.evidence.binary
                ? 'Response evidence unavailable: binary body was not retained.'
                : 'Response evidence was not retained.'
              : `${r.evidence.contentType || 'text'} · ${r.evidence.sizeBytes} bytes${r.evidence.truncated ? ' · excerpt truncated' : ''}${r.evidence.redacted ? ' · redacted' : ''}`}
          </p>
          {r.evidence.excerpt !== undefined && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 font-mono">
              {r.evidence.excerpt}
            </pre>
          )}
        </div>
      )}
      {onRerun && (
        <Button variant="ghost" size="sm" className="ml-6 h-6 text-[10px]" onClick={onRerun}>
          <Play className="mr-1 h-3 w-3" /> Run request
        </Button>
      )}
    </div>
  );
}

export function CollectionRunDetail({
  run,
  onClose,
  onRerun,
  comparisonRun,
}: {
  run: CollectionRunResult | null;
  onClose: () => void;
  onRerun?: (requestIds: string[]) => void;
  comparisonRun?: CollectionRunResult | null;
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
  const comparisonRequests = comparisonRun?.requests ?? [];

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
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              onClick={() =>
                onRerun?.(run.requests.filter((r) => r.status === 'failed').map((r) => r.itemId))
              }
              disabled={run.summary.failed === 0}
            >
              <Play className="mr-1 h-3 w-3" /> Rerun failed
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              onClick={() =>
                downloadBlob(renderCollectionRunJson(run), `restura-run-${run.id}.json`)
              }
            >
              <Download className="mr-1 h-3 w-3" /> JSON
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              onClick={() =>
                downloadBlob(
                  renderCollectionRunJUnit(run),
                  `restura-run-${run.id}.xml`,
                  'application/xml'
                )
              }
            >
              <Download className="mr-1 h-3 w-3" /> JUnit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              onClick={() =>
                downloadBlob(
                  renderCollectionRunHtml(run),
                  `restura-run-${run.id}.html`,
                  'text/html'
                )
              }
            >
              <Download className="mr-1 h-3 w-3" /> HTML
            </Button>
          </div>
          {comparisonRun && (
            <p className="text-[10px] text-muted-foreground">
              Comparing with {comparisonRun.scopeName}; missing, redacted, or truncated evidence is
              inconclusive.
            </p>
          )}
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
                {byIteration.get(iter)!.map((r, i) => {
                  const other = comparisonRequests.find(
                    (candidate) =>
                      candidate.itemId === r.itemId && candidate.iteration === r.iteration
                  );
                  const changed =
                    other &&
                    (other.status !== r.status ||
                      other.httpStatus !== r.httpStatus ||
                      other.evidence?.hash !== r.evidence?.hash);
                  return (
                    <div key={`${r.itemId}-${i}`}>
                      <RequestRow r={r} onRerun={onRerun ? () => onRerun([r.itemId]) : undefined} />
                      {comparisonRun && (
                        <p className="px-9 pb-2 text-[10px] text-muted-foreground">
                          {!other
                            ? 'No matching request in comparison run.'
                            : changed
                              ? `Changed: ${other.httpStatus ?? '-'} → ${r.httpStatus ?? '-'} · ${(r.durationMs ?? 0) - (other.durationMs ?? 0)}ms latency delta`
                              : 'No status or retained-evidence change.'}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
