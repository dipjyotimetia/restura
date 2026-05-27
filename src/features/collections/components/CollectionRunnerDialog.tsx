import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import {
  Play,
  StopCircle,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Clock,
  ChevronUp,
  ChevronDown,
  Upload,
  RotateCcw,
} from 'lucide-react';
import { flattenRunnables, findFolder } from '../lib/flattenRunnables';
import { loadDataFile, type IterationRow } from '../lib/dataLoader';
import { useCollectionRun } from '../hooks/useCollectionRun';
import { METHOD_COLORS, PROTOCOL_COLORS, PROTOCOL_LABELS } from '@/lib/shared/constants';
import { cn } from '@/lib/shared/utils';
import { toast } from 'sonner';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';

export interface RunnerScope {
  collectionId: string;
  /** When set, run only this folder's subtree; otherwise the whole collection. */
  folderId?: string;
}

interface Props {
  scope: RunnerScope | null;
  onClose: () => void;
}

function StatusIcon({ status }: { status: 'pending' | 'success' | 'failed' | 'skipped' }) {
  switch (status) {
    case 'success':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'skipped':
      return <MinusCircle className="h-4 w-4 text-amber-500" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

function CollectionRunnerDialogInner({ scope, onClose }: Props) {
  const collection = useCollectionStore((s) =>
    scope ? s.collections.find((c) => c.id === scope.collectionId) : undefined
  );
  const environments = useEnvironmentStore((s) => s.environments);
  const activeEnvironmentId = useEnvironmentStore((s) => s.activeEnvironmentId);

  const { running, progress, start, stop } = useCollectionRun();

  const [environmentId, setEnvironmentId] = useState<string>(activeEnvironmentId ?? 'none');
  const [iterations, setIterations] = useState(1);
  const [delayMs, setDelayMs] = useState(0);
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [dataRows, setDataRows] = useState<IterationRow[]>([]);
  const [dataFileName, setDataFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The ordered, selectable run list. Rebuilt whenever the scope changes.
  const allRunnables = useMemo(() => {
    if (!collection) return [];
    return flattenRunnables(collection.items, scope?.folderId);
  }, [collection, scope?.folderId]);

  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Initialise order + selection when the dialog opens on a new scope (i.e.
  // when the runnable set changes). The active environment is read fresh here
  // rather than depended on, so switching environments elsewhere while the
  // dialog is open does NOT wipe the user's in-progress run configuration.
  useEffect(() => {
    setOrder(allRunnables.map((r) => r.itemId));
    setSelected(new Set(allRunnables.map((r) => r.itemId)));
    setEnvironmentId(useEnvironmentStore.getState().activeEnvironmentId ?? 'none');
    setIterations(1);
    setDelayMs(0);
    setStopOnFailure(false);
    setDataRows([]);
    setDataFileName(null);
  }, [allRunnables]);

  const scopeName = useMemo(() => {
    if (!collection) return '';
    if (scope?.folderId) return findFolder(collection.items, scope.folderId)?.name ?? collection.name;
    return collection.name;
  }, [collection, scope?.folderId]);

  const orderedRunnables = useMemo(() => {
    const byId = new Map(allRunnables.map((r) => [r.itemId, r]));
    return order.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  }, [order, allRunnables]);

  const selectedRunnables = useMemo(
    () => orderedRunnables.filter((r) => selected.has(r.itemId)),
    [orderedRunnables, selected]
  );

  const move = (itemId: string, dir: -1 | 1) => {
    setOrder((prev) => {
      const idx = prev.indexOf(itemId);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[next]] = [copy[next]!, copy[idx]!];
      return copy;
    });
  };

  const handleDataFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const rows = await loadDataFile(file);
      setDataRows(rows);
      setDataFileName(`${file.name} (${rows.length} rows)`);
    } catch (err) {
      toast.error(`Failed to parse data file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRun = () => {
    if (!collection || selectedRunnables.length === 0) return;
    start({
      collection,
      scopeName,
      runnables: selectedRunnables,
      environmentId,
      iterations,
      dataRows,
      delayMs,
      stopOnFailure,
    });
  };

  const results = progress?.results ?? [];
  // Until the first progress event lands, estimate the denominator the same way
  // the runner will (requests × iterations, or × data rows when data-driven) so
  // the bar doesn't briefly overshoot 100% on multi-iteration runs.
  const total =
    progress?.total ?? selectedRunnables.length * Math.max(1, dataRows.length || iterations);
  // Whether to show the per-iteration badge — derived from the results so it
  // stays correct even if the data file is cleared after the run finishes.
  const showIteration = results.some((r) => r.iteration > 0);
  const isOpen = scope !== null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !running) onClose(); }}>
      <DialogContent className="max-w-4xl h-[82vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-4 w-4 text-primary" />
            Run {scope?.folderId ? 'folder' : 'collection'} — {scopeName}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-6 flex-1 overflow-hidden">
          {/* Config */}
          <div className="col-span-1 border-r pr-5 space-y-4 overflow-auto">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Environment</label>
              <Select value={environmentId} onValueChange={setEnvironmentId} disabled={running}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select environment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No environment</SelectItem>
                  {environments.map((env) => (
                    <SelectItem key={env.id} value={env.id}>{env.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                Iterations {dataRows.length > 0 && <span className="text-muted-foreground">(data file overrides)</span>}
              </label>
              <Input
                type="number"
                min={1}
                value={iterations}
                onChange={(e) => setIterations(Math.max(1, parseInt(e.target.value) || 1))}
                disabled={running || dataRows.length > 0}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Data file (CSV / JSON)</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                className="hidden"
                onChange={(e) => void handleDataFile(e.target.files?.[0] ?? undefined)}
              />
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs flex-1 justify-start"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={running}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  {dataFileName ? 'Replace' : 'Upload'}
                </Button>
                {dataRows.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="h-8 w-8"
                    onClick={() => { setDataRows([]); setDataFileName(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                    disabled={running}
                    aria-label="Clear data file"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              {dataFileName && <p className="text-[10px] text-muted-foreground truncate">{dataFileName}</p>}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Delay between requests (ms)</label>
              <Input
                type="number"
                min={0}
                value={delayMs}
                onChange={(e) => setDelayMs(Math.max(0, parseInt(e.target.value) || 0))}
                disabled={running}
                className="h-8 text-xs"
              />
            </div>

            <label className="flex items-center gap-2 text-xs font-medium">
              <Checkbox
                checked={stopOnFailure}
                onCheckedChange={(c) => setStopOnFailure(!!c)}
                disabled={running}
              />
              Stop on failure
            </label>

            {running ? (
              <Button className="w-full" variant="destructive" onClick={stop}>
                <StopCircle className="mr-2 h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button
                className="w-full"
                onClick={handleRun}
                disabled={!collection || selectedRunnables.length === 0}
              >
                <Play className="mr-2 h-4 w-4" /> Run {selectedRunnables.length} request
                {selectedRunnables.length === 1 ? '' : 's'}
              </Button>
            )}
            {!running && (
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Stop finishes the in-flight request, then halts. SSE / WebSocket / MCP requests are skipped.
              </p>
            )}
          </div>

          {/* Run list / results */}
          <div className="col-span-2 flex flex-col overflow-hidden">
            {results.length > 0 || running ? (
              <>
                <div className="mb-3 space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">
                      {progress?.current
                        ? `Running ${progress.current.itemName}…`
                        : progress?.done
                          ? 'Done'
                          : 'Starting…'}
                    </span>
                    <span className="font-mono tabular-nums">{results.length} / {total}</span>
                  </div>
                  <Progress value={(results.length / Math.max(total, 1)) * 100} />
                  {progress?.done && <RunSummary results={results} />}
                </div>
                <ScrollArea className="flex-1 border rounded-md">
                  <div className="divide-y divide-border/40">
                    {results.map((r, i) => (
                      <div key={`${r.itemId}-${r.iteration}-${i}`} className="flex items-center gap-2 px-3 py-2 text-xs">
                        <StatusIcon status={r.status} />
                        <ProtocolBadge protocol={r.protocol} />
                        <span className="flex-1 truncate">{r.itemName}</span>
                        {r.assertions.length > 0 && (
                          <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                            {r.assertions.filter((a) => a.passed).length}/{r.assertions.length} ✓
                          </span>
                        )}
                        {showIteration ? (
                          <span className="text-[10px] text-muted-foreground">#{r.iteration + 1}</span>
                        ) : null}
                        <span className="w-16 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                          {r.durationMs != null ? `${r.durationMs}ms` : r.skippedReason ? 'skip' : '-'}
                        </span>
                        <span className="w-10 text-right">
                          {r.httpStatus != null ? (
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
                          ) : (
                            '-'
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </>
            ) : (
              <RunList
                runnables={orderedRunnables}
                selected={selected}
                onToggle={(id) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onMove={move}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProtocolBadge({ protocol }: { protocol: string }) {
  const label = PROTOCOL_LABELS[protocol] ?? protocol.toUpperCase();
  const color = PROTOCOL_COLORS[protocol];
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-0.5 text-[9px] font-mono font-medium leading-none',
        color ?? 'bg-muted text-muted-foreground border border-border'
      )}
    >
      {label}
    </span>
  );
}

function RunSummary({ results }: { results: { status: string }[] }) {
  const passed = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  return (
    <div className="flex items-center gap-3 text-[11px] font-mono">
      <span className="text-emerald-600 dark:text-emerald-400">{passed} passed</span>
      <span className="text-red-600 dark:text-red-400">{failed} failed</span>
      {skipped > 0 && <span className="text-amber-600 dark:text-amber-400">{skipped} skipped</span>}
    </div>
  );
}

function RunList({
  runnables,
  selected,
  onToggle,
  onMove,
}: {
  runnables: { itemId: string; name: string; request: { type: string; method?: string } }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  if (runnables.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground border rounded-md">
        No requests in this scope.
      </div>
    );
  }
  return (
    <ScrollArea className="flex-1 border rounded-md">
      <div className="divide-y divide-border/40">
        {runnables.map((r, idx) => {
          const isHttp = r.request.type === 'http';
          const label = isHttp ? (r.request.method ?? 'GET') : PROTOCOL_LABELS[r.request.type] ?? r.request.type.toUpperCase();
          const color = isHttp ? METHOD_COLORS[r.request.method ?? 'GET'] : PROTOCOL_COLORS[r.request.type];
          return (
            <div key={r.itemId} className="group flex items-center gap-2 px-3 py-1.5 text-xs">
              <Checkbox checked={selected.has(r.itemId)} onCheckedChange={() => onToggle(r.itemId)} />
              <span
                className={cn(
                  'shrink-0 rounded px-1 py-0.5 text-[9px] font-mono font-medium leading-none',
                  color ?? 'bg-muted text-muted-foreground border border-border'
                )}
              >
                {label}
              </span>
              <span className="flex-1 truncate">{r.name}</span>
              <div className="flex items-center opacity-0 group-hover:opacity-100">
                <button
                  type="button"
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  onClick={() => onMove(r.itemId, -1)}
                  disabled={idx === 0}
                  aria-label="Move up"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  onClick={() => onMove(r.itemId, 1)}
                  disabled={idx === runnables.length - 1}
                  aria-label="Move down"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

export const CollectionRunnerDialog = withErrorBoundary(CollectionRunnerDialogInner);
